#!/usr/bin/env node
/**
 * ccr-doctor — explain WHY a gateway request failed (read-only; changes nothing)
 *
 * Usage:
 *   node src/ccr-doctor.mjs [--json] [--since 7d] [--limit 20]
 *
 * Why it exists: CCR records everything needed to diagnose a failure and then
 * analyses none of it. Measured on a real local install, of the failures that
 * carried a captured response body, CCR's own `error` column was empty for
 * three out of four — the upstream's actual explanation sat unread in
 * `response_body_text` the whole time.
 *
 * The four questions this answers:
 *   1. What actually failed?          -> extractUpstreamError / classifyFailure
 *   2. Did the model name survive?    -> resolutionAnomaly
 *   3. Why is the cache flapping?     -> cacheOscillation
 *   4. How often is CCR silent?       -> emptyErrorRate
 *
 * Every database is opened read-only. Nothing here writes.
 * Exit code: 1 = at least one `fail`; 0 = warnings only or all ok.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (!(w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message))) console.warn(w);
});

/**
 * Below this many prompt tokens a request is under the provider's minimum
 * cacheable block and will always miss. Counting those as "cache broken" is
 * the single most common way to misread a healthy gateway.
 */
export const MIN_CACHEABLE_TOKENS = 1024;

const LEVELS = { ok: 0, warn: 1, fail: 2 };

export function overallLevel(checks) {
  return checks.reduce((acc, c) => (LEVELS[c.level] > LEVELS[acc] ? c.level : acc), 'ok');
}

export function exitCodeFor(checks) {
  return overallLevel(checks) === 'fail' ? 1 : 0;
}

/**
 * Pull the upstream's own explanation out of a captured response body.
 *
 * Two envelopes are in the wild and they nest the type differently:
 *   OpenAI-ish:    {"error":{"message":..,"type":..,"code":..}}
 *   Anthropic-ish: {"type":"error","error":{"message":..,"type":..}}
 *
 * Returns nulls rather than throwing — a truncated or HTML body is a normal
 * thing to find in a log, not an exception.
 */
export function extractUpstreamError(text) {
  const empty = { message: null, type: null, code: null };
  if (typeof text !== 'string' || text.length === 0) return empty;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!j || typeof j !== 'object' || !j.error) return empty;
  const inner = typeof j.error === 'object' ? j.error : {};
  const message = typeof j.error === 'string' ? j.error : (inner.message ?? null);
  return {
    message,
    type: inner.type ?? (typeof j.type === 'string' && j.type !== 'error' ? j.type : null),
    code: inner.code ?? null,
  };
}

/**
 * Turn a failure row into a named class, a plain-language cause, and an action.
 *
 * The point is to stop at a NAME, not to echo the upstream string. "Can only
 * get item pairs from a mapping" is not a diagnosis; "an assistant turn has a
 * tool_use with no matching tool_result" is.
 */
export function classifyFailure(row) {
  const status = Number(row?.status_code) || 0;
  const err = String(row?.error ?? '');
  const { message, type } = extractUpstreamError(row?.response_body_text);
  const hay = `${err} ${message ?? ''} ${type ?? ''}`.toLowerCase();
  const attempts = Number(row?.route_attempt_count) || 1;

  if (status === 499 || /client connection closed|aborted|socket hang up/.test(hay)) {
    return {
      class: 'client-abort',
      cause: 'The client hung up before the upstream finished responding.',
      action: 'Not an upstream fault. On a 400KB+ request this usually means the client timed out mid-flight — check the client timeout before blaming the gateway.',
    };
  }

  if (status === 429 || /rate.?limit|too many requests|请求过于频繁/.test(hay)) {
    return {
      class: 'rate-limited',
      cause: `Upstream refused on rate limits after ${attempts} attempt(s).`,
      action: attempts > 1
        ? 'Retries exhausted — the upstream RPM is below your concurrency. Lower parallel fan-out, or raise retryCount with a longer backoff.'
        : 'First attempt was refused. Check whether Router.fallback is set to "retry"; with mode=off the 429 goes straight back to the client.',
    };
  }

  if (status === 401 || status === 403 || /unauthor|invalid.?api.?key|forbidden|authentication/.test(hay)) {
    return {
      class: 'auth',
      cause: 'The upstream rejected the credential.',
      action: 'Re-check this provider\'s key in CCR settings. If the key was rotated upstream, every request on this path will fail until it is updated.',
    };
  }

  if (/item pairs from a mapping|tool_use.*tool_result|tool_result.*tool_use/.test(hay)) {
    return {
      class: 'tool-pairing',
      cause: 'An assistant turn carries a tool_use with no matching tool_result (an orphaned block).',
      action: 'The upstream rejects unpaired tool blocks. A gateway-side cleaner that strips or re-pairs them fixes this — check whether one is installed and whether it is enabled for this provider.',
    };
  }

  if (/unknown field|未知字段|unexpected field|additional properties/.test(hay)) {
    return {
      class: 'unknown-field',
      cause: 'The request carried a field this upstream does not accept.',
      action: `The upstream does not say which field. Inspect the captured request body for this row (${row?.request_body_size_bytes ?? '?'} bytes) — look for fields your client adds that the provider's own SDK would not send.`,
    };
  }

  if (status >= 500) {
    return {
      class: 'upstream-5xx',
      cause: `The upstream returned ${status}.`,
      action: 'Usually transient or capacity-related. If it repeats on one provider only, that provider is the problem — switch or drop it.',
    };
  }

  if (status === 400 || status === 422) {
    // A 4xx with nothing recorded anywhere is the headline case this tool
    // exists for — do not dress it up as a diagnosis we did not make.
    if (!message && err.trim().length === 0) {
      return {
        class: 'opaque',
        cause: 'CCR recorded a failure with no usable message and no captured body.',
        action: 'Nothing to diagnose from this row. Check the body-capture policy: bodies over 160KB are folded into a preview, which makes forensics impossible for exactly the large requests most likely to fail.',
      };
    }
    return {
      class: 'bad-request',
      cause: message ?? 'The upstream rejected the request shape but recorded no message.',
      action: 'Compare this request against a request on the same provider that succeeded — the difference is the fault.',
    };
  }

  return {
    class: 'opaque',
    cause: 'CCR recorded a failure with no usable message and no captured body.',
    action: 'Nothing to diagnose from this row. Check the body-capture policy: bodies over 160KB are folded into a preview, which makes forensics impossible for exactly the large requests most likely to fail.',
  };
}

/**
 * Model names travel requested -> resolved -> response. Two things go wrong:
 *   - the protocol name leaks into resolved_model ("agenes::openai_chat_completions/agnes-3.0-flash")
 *   - resolution succeeds but no response model comes back, i.e. the call died in flight
 * Both are invisible unless you compare the three columns.
 */
export function resolutionAnomaly(row) {
  const requested = row?.requested_model ?? '';
  const resolved = row?.resolved_model ?? '';
  const response = row?.response_model ?? '';
  const status = Number(row?.status_code) || 0;

  if (/::/.test(resolved) || /::/.test(requested)) {
    return `Protocol name leaked into the model id (${resolved || requested}) — CCR resolves to an internal "<provider>::<protocol>/<model>" form. Anything keying off the model string (cache identity, pricing, per-model routing) will not match.`;
  }

  // A missing response model on a request that ALREADY failed adds nothing:
  // the failure list reports that row once, and repeating it as a second
  // warning is noise. Measured: every such row was a 400/429/499.
  if (status >= 400) return null;

  return null;
}

/**
 * Detect a cache REGRESSION: the same prefix, no longer hitting.
 *
 * The naive detector — "does the hit rate flip on and off?" — is wrong, and
 * measured live data proves it. A long cached session ends and a new one begins
 * with a much smaller prefix (measured: 465K tokens cached, then a fresh 40K
 * session). The rate flips, but nothing is broken: a new session is *supposed*
 * to start cold. Flagging that would have reported two healthy paths
 * (98.8% and 90.2% real hit rates) as oscillating.
 *
 * The actual signature of drift is: the prefix is the same size as before, but
 * the cache stopped reading it. So compare each miss against the most recent
 * hit — if the prefix barely moved and the cache vanished anyway, the bytes
 * that make up that prefix changed underneath.
 *
 * Only requests at or above MIN_CACHEABLE_TOKENS are eligible: tiny requests
 * always miss and would manufacture drift that is not there.
 */
export function cacheOscillation(rows, minTokens = MIN_CACHEABLE_TOKENS) {
  const eligible = (rows ?? []).filter((r) => {
    const total = (Number(r?.cache_read_tokens) || 0) + (Number(r?.input_tokens) || 0);
    return total >= minTokens;
  });
  const empty = { oscillating: false, regressions: 0, eligible: eligible.length, hit: 0, miss: 0 };

  const measure = (r) => {
    const cached = Number(r.cache_read_tokens) || 0;
    const total = cached + (Number(r.input_tokens) || 0);
    return { cached, total, hit: total > 0 && cached / total >= 0.5 };
  };
  const stats = eligible.map(measure);
  const hitCount = stats.filter((s) => s.hit).length;
  const missCount = stats.length - hitCount;
  if (stats.length < 4) return { ...empty, hit: hitCount, miss: missCount };

  // A miss only counts as a regression if the prefix it carried is close in
  // size to the last prefix that did hit — otherwise it is a new session.
  let regressions = 0;
  let lastHitTotal = null;
  for (const s of stats) {
    if (s.hit) {
      lastHitTotal = s.total;
      continue;
    }
    if (lastHitTotal !== null) {
      const drift = Math.abs(s.total - lastHitTotal) / Math.max(s.total, lastHitTotal);
      if (drift <= 0.2) regressions++;
    }
  }

  // A couple of regressions across hundreds of requests is cache TTL expiring
  // and sessions restarting — normal, not a finding. Only a pattern worth
  // acting on clears this bar: at least 3 of them, on at least a tenth of the
  // cacheable requests. Measured healthy paths sit at 1-4% and stay quiet.
  const rate = stats.length > 0 ? regressions / stats.length : 0;
  return {
    oscillating: regressions >= 3 && rate >= 0.1,
    regressions,
    eligible: stats.length,
    hit: hitCount,
    miss: missCount,
    rate,
  };
}

/**
 * How often did CCR log a failure with nothing a human could act on?
 *
 * This is the metric the whole tool is built around: it converts "the gateway
 * is unreliable" into a number you can track going down.
 */
export function emptyErrorRate(rows) {
  const failures = (rows ?? []).filter((r) => Number(r?.status_code) >= 400);
  if (failures.length === 0) return { failures: 0, empty: 0, rate: null };
  const empty = failures.filter((r) => {
    const hasErr = String(r?.error ?? '').trim().length > 0;
    const { message } = extractUpstreamError(r?.response_body_text);
    return !hasErr && !message;
  }).length;
  return { failures: failures.length, empty, rate: empty / failures.length };
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

export function windowToMs(spec, nowMs = Date.now()) {
  const m = /^(\d+)([dhms])$/.exec(String(spec ?? '').trim());
  if (!m) return 7 * 86400000;
  const n = Number(m[1]);
  const unit = { d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[2]];
  return n * unit;
}

export function notInstalled() {
  return {
    checks: [{ id: 'requestLogs', level: 'warn', detail: 'CCR request log not found — nothing to diagnose' }],
    failures: [],
    facts: { ccrInstalled: false },
  };
}

function collect(sinceMs, limit) {
  const p = locate('request-logs.sqlite');
  if (!p) return notInstalled();

  const db = openRo(p);
  try {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const rows = db.prepare(`
      SELECT id, created_at, provider, client, requested_model, resolved_model, response_model,
             status_code, duration_ms, route_attempt_count, error,
             request_body_size_bytes, response_body_text, cache_read_tokens, input_tokens
        FROM request_logs
       WHERE created_at >= ?
       ORDER BY created_at DESC`).all(since);

    const checks = [];
    const failures = [];

    // --- failures, each classified ---
    const failed = rows.filter((r) => Number(r.status_code) >= 400);
    for (const r of failed) {
      const d = classifyFailure(r);
      const anomaly = resolutionAnomaly(r);
      const { message } = extractUpstreamError(r.response_body_text);
      failures.push({
        id: r.id,
        at: r.created_at,
        provider: r.provider,
        status: r.status_code,
        class: d.class,
        cause: d.cause,
        action: d.action,
        upstreamMessage: message,
        anomaly,
      });
    }

    const rate = emptyErrorRate(rows);
    if (rate.failures === 0) {
      checks.push({ id: 'silentFailures', level: 'ok', detail: `No failed requests in the last ${Math.round(sinceMs / 86400000)}d` });
    } else if (rate.empty === 0) {
      checks.push({
        id: 'silentFailures', level: 'ok',
        detail: `All ${rate.failures} failure(s) carried a usable message — nothing is being swallowed`,
      });
    } else {
      const pct = Math.round(rate.rate * 100);
      checks.push({
        id: 'silentFailures', level: pct >= 50 ? 'warn' : 'ok',
        detail: `${rate.empty}/${rate.failures} failures (${pct}%) carried no usable message — the upstream's explanation was either not captured or sits unread in response_body_text`,
      });
    }

    // --- cache oscillation, per provider|model ---
    const groups = new Map();
    for (const r of rows) {
      if (Number(r.status_code) !== 200) continue;
      const k = `${r.provider || 'unknown'}|${r.response_model || r.resolved_model || 'unknown'}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const flapping = [];
    for (const [k, rs] of groups) {
      const osc = cacheOscillation(rs);
      if (osc.oscillating) {
        flapping.push(`${k} (${osc.regressions} regression(s) in ${osc.eligible} cacheable requests, ${osc.hit} hit / ${osc.miss} miss)`);
      }
    }
    checks.push(flapping.length === 0
      ? { id: 'cacheStability', level: 'ok', detail: 'No cache regression detected — every miss was a genuinely new prefix' }
      : {
          id: 'cacheStability', level: 'warn',
          detail: `Cache regressed on an unchanged prefix: ${flapping.join('; ')} — the request's cached prefix changed without changing size, which points at an injected block being edited between requests`,
        });

    // Only anomalies that are NOT already visible in the failure list. A leaked
    // protocol name on a request that also failed is reported once, with its
    // cause — repeating it here would double-count the same event.
    const leaks = rows.filter((r) => Number(r.status_code) < 400 && /::/.test(`${r.resolved_model ?? ''}${r.requested_model ?? ''}`)).length;
    checks.push(leaks === 0
      ? { id: 'modelResolution', level: 'ok', detail: 'No protocol name leaked into a resolved model id' }
      : { id: 'modelResolution', level: 'warn', detail: `${leaks} successful request(s) resolved to an internal "<provider>::<protocol>/<model>" id — anything keying off the model string (cache identity, pricing) will not match it` });

    const byClass = {};
    for (const f of failures) byClass[f.class] = (byClass[f.class] || 0) + 1;

    return {
      checks,
      failures: failures.slice(0, limit),
      facts: {
        ccrInstalled: true,
        window: `${Math.round(sinceMs / 86400000)}d`,
        requests: rows.length,
        failed: failed.length,
        byClass,
        emptyErrorRate: rate.rate,
      },
    };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const out = { json: false, since: '7d', limit: 20 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--since') out.since = argv[++i];
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { checks, failures, facts } = collect(windowToMs(args.since), args.limit);
  const level = overallLevel(checks);

  if (args.json) {
    console.log(JSON.stringify({ level, checks, failures, facts }, null, 2));
    process.exit(exitCodeFor(checks));
  }

  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  console.log(`CCR doctor — why did it fail? (read-only, last ${facts.window ?? args.since})\n`);

  for (const c of checks) console.log(`  ${icon[c.level]} ${c.id.padEnd(16)} ${c.detail}`);

  if (failures.length > 0) {
    console.log(`\n  ${failures.length} failure(s):\n`);
    for (const f of failures) {
      console.log(`  #${f.id}  ${f.at}  [${f.provider}]  HTTP ${f.status}  → ${f.class}`);
      console.log(`        cause:  ${f.cause}`);
      console.log(`        action: ${f.action}`);
      if (f.upstreamMessage) console.log(`        upstream said: "${f.upstreamMessage}"`);
      if (f.anomaly) console.log(`        ⚠ ${f.anomaly}`);
      console.log('');
    }
  } else if (facts.ccrInstalled !== false) {
    console.log('\n  No failures in this window.\n');
  }

  if (facts.ccrInstalled === false) {
    console.log('\n  Nothing to do — this tool diagnoses a local CCR installation.');
  } else {
    console.log(`  ${facts.requests} request(s), ${facts.failed} failed.`);
    if (Object.keys(facts.byClass ?? {}).length > 0) {
      console.log(`  Failure classes: ${Object.entries(facts.byClass).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
  }
  console.log(`\n  Overall: ${icon[level]} ${level.toUpperCase()}`);
  process.exit(exitCodeFor(checks));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
