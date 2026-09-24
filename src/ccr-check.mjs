#!/usr/bin/env node
/**
 * ccr-check — CCR 网关健康体检（只读，不改任何配置）
 *
 * 用法：
 *   node scripts/maintain/ccr-check.mjs [--json] [--hit-threshold 50]
 *
 * 为什么存在：2026-09-13 对 CCR 3.1.0 做了一次全量取证，所有结论都是手工查
 * config.sqlite / usage.sqlite / request-logs.sqlite 得出的，做完就散了。
 * 这个脚本把那些检查固化成可重复的一条命令，防止同样的问题重新长回来。
 *
 * 检查项（每项都有对应单测，fixture 取自本机真实数据）：
 *   1. Router.fallback —— mode=off 时 429 会直接抛给客户端（实测就是这么发生的）
 *   2. Claude Code profile —— 五个槽位是否齐全、是否有自公告过期的模型
 *   3. 数据库膨胀 —— SQLite 删行不还盘，request-logs 实测 598MB 里 97.7% 是空页
 *   4. 请求体取证可用率 —— CCR 把超 160KB 的 body 折成"预览"（中间插省略标记），
 *      导致 JSON 断裂且 request_body_truncated 不置位
 *   5. status=0 记录缺口 —— 计入失败会把 ~90% 成功率误算成 66.7%
 *
 * 全部只读打开（mode=ro），不会干扰正在运行的 CCR。
 * 退出码：1 = 有 fail 项；0 = 仅 warn 或全 ok（warn 不打断自动化）。
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

// CCR 把超限 body 折成预览时插入的标记（见 app.asar 内 Cse/fae 两个函数，上限 qf=160*1024）
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
 * 按时间窗口把时间戳聚成事件。同一次并行爆发里的多条 429 会被并成一个事件。
 * 簇内平均间隔还能区分成因：
 *   秒级 / 亚秒级间隔 → parallel（客户端并行打爆 RPM）
 *   均匀的数秒以上间隔 → sequential（顺序退避重试）
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
 * 限流体检。**报事件数而不是原始条数** —— 实测 494 条 429 只聚成 53 个事件，
 * 直接报条数会把问题夸大近 10 倍。并行爆发占比高时指向客户端 fan-out 超过上游 RPM。
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

function collect() {
  const checks = [];
  const facts = {};

  // 1+2. 配置
  const cfgPath = locate('config.sqlite');
  if (!cfgPath) {
    checks.push({ id: 'config', level: 'fail', detail: 'config.sqlite not found — is CCR installed?' });
  } else {
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

  // 3. 膨胀
  for (const name of ['request-logs.sqlite', 'usage.sqlite', 'context-archive.sqlite']) {
    const p = locate(name);
    if (!p) continue;
    try {
      checks.push(checkBloat({ label: name.replace('.sqlite', ''), fileBytes: fs.statSync(p).size, liveBytes: liveBytes(p) }));
    } catch { /* 读不到只是少一项检查 */ }
  }

  // 4. 请求体取证可用率
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

  // 5. 状态缺口 + 在用路径命中率
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

      // 限流按事件数报，不按原始条数（见 checkRateLimitBursts 注释）
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

      // 逐条判口径（与 cache-monitor 同一套规则，避免两处口径漂移）
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
    process.exit(exitCodeFor(checks));
  }

  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  console.log('CCR health check (read-only)\n');
  for (const c of checks) console.log(`  ${icon[c.level]} ${c.id.padEnd(11)} ${c.detail}`);
  console.log(`\n  Overall: ${icon[level]} ${level.toUpperCase()}`);
  if (facts.providers !== undefined) console.log(`  providers: ${facts.providers}`);
  if (facts.successRate !== undefined) console.log(`  7-day success rate (logging gap excluded): ${facts.successRate.toFixed(1)}%${facts.topFailure ? `; top failure ${facts.topFailure}` : ''}`);
  if (level !== 'ok') console.log('\n  Tip: back up config.sqlite before changing CCR config; changes need a CCR restart to take effect.');
  process.exit(exitCodeFor(checks));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
