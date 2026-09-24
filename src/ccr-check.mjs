#!/usr/bin/env node
/**
 * ccr-check — CCR gateway health check (read-only; changes nothing)
 *
 * Usage:
 *   node src/ccr-check.mjs [--json] [--hit-threshold 50]
 *
 * Why it exists: a full forensic pass over CCR 3.1.0 was done by hand —
 * every conclusion reached by querying config.sqlite / usage.sqlite /
 * request-logs.sqlite manually, and then scattered to the wind. This script
 * freezes those checks into one repeatable command so the same problems cannot
 * quietly grow back.
 *
 * Checks (each has unit tests; fixtures taken from real local data):
 *   1. Router.fallback — with mode=off, a 429 is thrown straight at the client
 *      (measured: exactly how it happened)
 *   2. Claude Code profile — are all five slots set, and does any slot point at
 *      a model that self-declares an expiry
 *   3. Database bloat — SQLite does not return disk space on row deletion;
 *      request-logs measured 598MB of which 97.7% was free pages
 *   4. Request-body forensic usability — CCR folds bodies over 160KB into a
 *      "preview" (an elision marker spliced into the middle), which breaks the
 *      JSON while request_body_truncated stays unset
 *   5. status=0 logging gap — counting these as failures turns a ~90% success
 *      rate into 66.7%
 *
 * Everything opens read-only (mode=ro) and never disturbs a running CCR.
 * Exit code: 1 = at least one `fail`; 0 = warnings only or all ok
 * (a warning does not break automation).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveConvention, hitRateOf, summarizeStatus } from './cache-monitor.mjs';

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (!(w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message))) console.warn(w);
});

// The marker CCR splices in when it folds an oversized body into a preview
// (see the two helpers in app.asar; the cutoff is 160*1024 bytes).
export const PREVIEW_MARKER = /\.\.\. (\d+) bytes omitted from preview \.\.\./;

export function hasPreviewMarker(text) {
  return typeof text === 'string' && PREVIEW_MARKER.test(text);
}

export function previewOmittedBytes(text) {
  if (typeof text !== 'string') return null;
  const re = new RegExp(PREVIEW_MARKER.source, 'g');
  const hits = [...text.matchAll(re)];
  return hits.length === 0 ? null : hits.reduce((s, m) => s + Number(m[1]), 0);
}

const LEVELS = { ok: 0, warn: 1, fail: 2 };

export function overallLevel(checks) {
  return checks.reduce((acc, c) => (LEVELS[c.level] > LEVELS[acc] ? c.level : acc), 'ok');
}

export function exitCodeFor(checks) {
  return overallLevel(checks) === 'fail' ? 1 : 0;
}

export function checkFallback(fallback) {
  if (!fallback || typeof fallback !== 'object') {
    return { id: 'fallback', level: 'warn', detail: 'Router.fallback missing — cannot assess failover behaviour' };
  }
  if (fallback.mode === 'off') {
    return {
      id: 'fallback', level: 'fail',
      detail: `mode=off: 429/5xx go straight back to the client — no retry, no model switch (this is how 429s leaked through in practice). Set mode="retry"`,
    };
  }
  if (fallback.mode === 'model-chain') {
    return {
      id: 'fallback', level: 'warn',
      detail: `mode=model-chain: failures switch to ${(fallback.models || []).length} backup model(s); switching changes cache identity and can sacrifice prefix caching`,
    };
  }
  return { id: 'fallback', level: 'ok', detail: `mode=${fallback.mode} retryCount=${fallback.retryCount ?? '?'}` };
}

const SLOTS = ['model', 'opusModel', 'sonnetModel', 'haikuModel', 'fableModel'];

export function checkProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return { id: 'profile', level: 'warn', detail: 'No Claude Code profile found' };
  }
  const missing = SLOTS.filter((s) => !profile[s]);
  if (missing.length > 0) {
    return { id: 'profile', level: 'fail', detail: `Empty slot(s): ${missing.join(', ')} — that alias has no usable model` };
  }
  const expiring = SLOTS.filter((s) => /expires-on/i.test(String(profile[s])));
  if (expiring.length > 0) {
    return {
      id: 'profile', level: 'warn',
      detail: `Slot(s) point at a model that self-declares an expiry: ${expiring.map((s) => `${s}=${profile[s]}`).join(', ')}`,
    };
  }
  const same = profile.model && profile.model === profile.sonnetModel;
  return {
    id: 'profile', level: 'ok',
    detail: same ? `All five slots set; main and sonnet both point at ${profile.model}, so background verification loses independence` : 'All five slots set',
  };
}

export function checkBloat({ label, fileBytes, liveBytes }, ratioThreshold = 0.5) {
  if (!fileBytes || !liveBytes) return { id: 'bloat', level: 'ok', detail: `${label}: empty database` };
  const reclaimable = fileBytes - liveBytes;
  const ratio = reclaimable / fileBytes;
  const mb = (n) => (n / 1048576).toFixed(1);
  if (ratio > ratioThreshold) {
    return {
      id: 'bloat', level: 'warn',
      detail: `${label}: file is ${mb(fileBytes)}MB but only ${mb(liveBytes)}MB is live (${Math.round(ratio * 100)}% free pages); ${mb(reclaimable)}MB reclaimable — stop CCR, then VACUUM`,
    };
  }
  return { id: 'bloat', level: 'ok', detail: `${label}: ${mb(fileBytes)}MB, ${mb(liveBytes)}MB live` };
}

export function checkPreviewLoss(texts) {
  const total = texts.length;
  const lossy = texts.filter(hasPreviewMarker).length;
  if (total === 0) return { id: 'preview', level: 'ok', detail: 'Request log is empty — nothing to assess' };
  const rate = lossy / total;
  if (rate > 0.5) {
    return {
      id: 'preview', level: 'warn',
      detail: `${lossy}/${total} (${Math.round(rate * 100)}%) request bodies stored as preview only: bodies over 160KB get an elision marker spliced into the middle, breaking the JSON while request_body_truncated stays unset → forensics limited`,
    };
  }
  return { id: 'preview', level: 'ok', detail: `${lossy}/${total} request bodies folded into a preview` };
}

export function checkLoggingGap(statusRows) {
  const gap = statusRows.find((r) => r.status_code === 0);
  if (gap && gap.n > 0) {
    return {
      id: 'loggingGap', level: 'warn',
      detail: `${gap.n} row(s) with status=0 (succeeded but status not recorded) — counting these as failures understates the success rate; exclude them`,
    };
  }
  return { id: 'loggingGap', level: 'ok', detail: 'No status=0 logging gap' };
}

/**
 * Cluster timestamps into events using a time window, so several 429s from one
 * parallel burst collapse into a single event.
 *
 * The average gap inside a cluster distinguishes the cause:
 *   sub-second / one-second gaps -> parallel (client fan-out blew the RPM limit)
 *   even gaps of several seconds -> sequential (retry with backoff)
 */
export function clusterTimestamps(timestamps, windowSeconds) {
  const ts = timestamps.map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (ts.length === 0) return { total: 0, events: [] };
  const groups = [[ts[0]]];
  for (const t of ts.slice(1)) {
    const cur = groups[groups.length - 1];
    if ((t - cur[cur.length - 1]) / 1000 <= windowSeconds) cur.push(t);
    else groups.push([t]);
  }
  const events = groups.map((g) => {
    const gaps = g.slice(1).map((t, i) => (t - g[i]) / 1000);
    const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
    let pattern = 'isolated';
    if (g.length > 1) pattern = avgGap !== null && avgGap <= 2 ? 'parallel' : 'sequential';
    return { count: g.length, first: new Date(g[0]).toISOString(), spanSeconds: (g[g.length - 1] - g[0]) / 1000, pattern };
  });
  return { total: ts.length, events };
}

/**
 * Rate-limit check. Report the EVENT COUNT, not the raw row count: measured
 * 494 rate-limit rows collapsed into just 53 events, so reporting rows inflates
 * the problem roughly tenfold. A high share of parallel bursts points at client
 * fan-out exceeding the upstream RPM limit rather than a config problem.
 */
export function checkRateLimitBursts(timestamps, windowSeconds = 10) {
  const { total, events } = clusterTimestamps(timestamps, windowSeconds);
  if (total === 0) return { id: 'rateLimit', level: 'ok', detail: 'No 429 / rate-limit rows' };
  const bursts = events.filter((e) => e.pattern === 'parallel');
  const burstHits = bursts.reduce((s, e) => s + e.count, 0);
  const share = Math.round((burstHits / total) * 100);
  if (bursts.length > 0 && share >= 50) {
    return {
      id: 'rateLimit', level: 'warn',
      detail: `${total} rate-limit rows cluster into ${events.length} event(s), of which ${bursts.length} are concurrency bursts (${share}% of rows) — points at parallel fan-out exceeding the upstream RPM, not a config problem`,
    };
  }
  return {
    id: 'rateLimit', level: 'ok',
    detail: `${total} rate-limit rows cluster into ${events.length} event(s); no significant concurrency burst`,
  };
}

function locate(name) {
  const candidates = [
    process.env.CCR_HOME && path.join(process.env.CCR_HOME, name),
    path.join(process.env.APPDATA || '', 'claude-code-router', name),
    path.join(os.homedir(), 'AppData', 'Roaming', 'claude-code-router', name),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function openRo(p) {
  return new DatabaseSync(p, { readOnly: true });
}

function liveBytes(dbPath) {
  const db = openRo(dbPath);
  try {
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    const freePages = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    return (pageCount - freePages) * pageSize;
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const out = { json: false, hitThreshold: 50 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--hit-threshold') out.hitThreshold = Number(argv[++i]);
  }
  return out;
}

/**
 * "CCR is not installed here" is not a configuration fault — it is simply not
 * applicable. Reporting it as `fail` (and exiting 1) makes the tool unusable in
 * CI on a machine without CCR, which is exactly where a smoke test runs.
 */
export function notInstalled() {
  return {
    checks: [{ id: 'config', level: 'warn', detail: 'CCR not found on this machine — nothing to check' }],
    facts: { ccrInstalled: false },
  };
}

function collect() {
  const checks = [];
  const facts = {};

  // 1+2. config
  const cfgPath = locate('config.sqlite');
  if (!cfgPath) {
    const empty = notInstalled();
    return { checks: empty.checks, facts: empty.facts, degraded: true };
  }
  {
    const db = openRo(cfgPath);
    try {
      const row = db.prepare("SELECT value_json FROM app_config WHERE key = 'default'").get();
      const cfg = JSON.parse(row.value_json);
      facts.providers = (cfg.Providers || []).length;
      checks.push(checkFallback(cfg.Router?.fallback));
      checks.push(checkProfile(cfg.profile?.claudeCode));
    } catch (e) {
      checks.push({ id: 'config', level: 'fail', detail: `Failed to read config.sqlite: ${e.message}` });
    } finally {
      db.close();
    }
  }

  // 3. bloat
  for (const name of ['request-logs.sqlite', 'usage.sqlite', 'context-archive.sqlite']) {
    const p = locate(name);
    if (!p) continue;
    try {
      checks.push(checkBloat({ label: name.replace('.sqlite', ''), fileBytes: fs.statSync(p).size, liveBytes: liveBytes(p) }));
    } catch { /* unreadable just means one fewer check, not an error */ }
  }

  // 4. request-body forensic usability
  const logsPath = locate('request-logs.sqlite');
  if (logsPath) {
    const db = openRo(logsPath);
    try {
      const texts = db.prepare('SELECT request_body_text AS t FROM request_logs WHERE length(request_body_text) > 0').all().map((r) => r.t);
      checks.push(checkPreviewLoss(texts));
      facts.requestLogRows = db.prepare('SELECT COUNT(*) AS n FROM request_logs').get().n;
    } catch { /* ignore */ } finally {
      db.close();
    }
  }

  // 5. logging gap + live-path hit rate
  const usagePath = locate('usage.sqlite');
  if (usagePath) {
    const db = openRo(usagePath);
    try {
      const statusRows = db.prepare(
        'SELECT status_code, COUNT(*) AS n FROM usage_events WHERE created_at >= ? GROUP BY status_code'
      ).all(new Date(Date.now() - 7 * 86400000).toISOString());
      checks.push(checkLoggingGap(statusRows));
      const health = summarizeStatus(statusRows);
      facts.successRate = health.successRate;
      facts.topFailure = health.topFailure;

      // Report rate limits by event count, not raw rows (see checkRateLimitBursts)
      const rlTs = db.prepare(
        'SELECT created_at FROM usage_events WHERE status_code = 429 AND created_at >= ? ORDER BY created_at'
      ).all(new Date(Date.now() - 7 * 86400000).toISOString()).map((r) => r.created_at);
      checks.push(checkRateLimitBursts(rlTs));
      facts.rateLimitRaw = rlTs.length;

      const series = db.prepare(`
        SELECT COALESCE(NULLIF(provider,''),'unknown') AS provider, model,
               SUM(COALESCE(input_tokens,0)) AS uncached, SUM(COALESCE(cache_read_tokens,0)) AS cached,
               COUNT(*) AS requests, MAX(created_at) AS last_seen
          FROM usage_events WHERE created_at >= ? AND model IS NOT NULL AND TRIM(model) <> ''
         GROUP BY provider, model`).all(new Date(Date.now() - 7 * 86400000).toISOString());
      const samples = db.prepare(`
        SELECT COALESCE(NULLIF(provider,''),'unknown') AS provider, model,
               input_tokens AS i, cache_read_tokens AS c
          FROM usage_events WHERE created_at >= ? AND cache_read_tokens > 0 AND input_tokens > 0
         ORDER BY created_at DESC LIMIT 4000`).all(new Date(Date.now() - 7 * 86400000).toISOString());

      // Decide the convention per row, using the same rules as cache-monitor so the two cannot drift
      const byKey = new Map();
      for (const s of samples) {
        const k = `${s.provider}|${s.model}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(s.i / s.c);
      }
      const conv = new Map();
      for (const [k, ratios] of byKey) {
        ratios.sort((a, b) => a - b);
        conv.set(k, ratios[Math.floor(ratios.length / 2)] < 0.25 ? 'remainder' : 'total');
      }

      const low = [];
      for (const r of series) {
        if (r.requests < 5 || r.cached === 0) continue;
        const live = (Date.now() - Date.parse(r.last_seen)) <= 24 * 3600000;
        if (!live) continue;
        const { convention } = resolveConvention(conv.get(`${r.provider}|${r.model}`), r.uncached, r.cached);
        const rate = hitRateOf(convention, r.uncached, r.cached);
        if (rate !== null && rate < 50) low.push(`${r.provider}/${r.model} ${rate.toFixed(1)}%`);
      }
      checks.push(low.length === 0
        ? { id: 'hitRate', level: 'ok', detail: `No live path below 50%` }
        : { id: 'hitRate', level: 'warn', detail: `Live path(s) below threshold: ${low.join(', ')}` });
    } catch { /* ignore */ } finally {
      db.close();
    }
  }

  return { checks, facts };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { checks, facts } = collect();
  const level = overallLevel(checks);

  if (args.json) {
    console.log(JSON.stringify({ level, checks, facts }, null, 2));
    // A machine without CCR has nothing wrong with it, so this exits 0 —
    // otherwise the tool is unusable in CI wherever CCR is not installed.
    process.exit(exitCodeFor(checks));
  }

  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  console.log('CCR health check (read-only)\n');
  for (const c of checks) console.log(`  ${icon[c.level]} ${c.id.padEnd(11)} ${c.detail}`);
  console.log(`\n  Overall: ${icon[level]} ${level.toUpperCase()}`);
  if (facts.providers !== undefined) console.log(`  providers: ${facts.providers}`);
  if (facts.successRate !== undefined) console.log(`  7-day success rate (logging gap excluded): ${facts.successRate.toFixed(1)}%${facts.topFailure ? `; top failure ${facts.topFailure}` : ''}`);
  if (facts.ccrInstalled === false) {
    console.log('\n  Nothing to do — this tool audits a local CCR installation.');
  } else if (level !== 'ok') {
    console.log('\n  Tip: back up config.sqlite before changing CCR config; changes need a CCR restart to take effect.');
  }
  process.exit(exitCodeFor(checks));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
