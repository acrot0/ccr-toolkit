#!/usr/bin/env node
/**
 * cache-monitor — prompt cache hit rate (data source: CCR's usage.sqlite)
 *
 * Usage:
 *   node src/cache-monitor.mjs [--window 24h] [--threshold 50] [--live-hours 24] [--json]
 *
 * Definition: hit rate = cache_read / (input + cache_read)
 *   `input` counts input tokens that MISSED the cache; `cache_read` counts the
 *   part that hit. Their sum is the full prefix length of the request, so the
 *   ratio is the true prefix hit rate.
 *
 * Exit code: 0 = everything meets the threshold, or too few samples to judge;
 *            1 = a LIVE path is below the threshold (usable as a CI gate).
 *
 * TWO DESIGN DECISIONS, both forced by measured data (see the tests):
 *
 *   1. Group by provider|model, not by model. The reporting convention can
 *      differ per provider even for the same model (measured: two conventions
 *      coexist inside one CCR), and the main driver of a hit-rate difference is
 *      the PROTOCOL the provider is routed over — the same model scored 0% on
 *      the anthropic path and 57.9% on openai_chat_completions. Grouping by
 *      model alone smears those two into a single misleading row.
 *
 *   2. Add a "live" notion (seen within 24h by default). Retired paths still
 *      fall inside --window, and the earlier version reported a decommissioned
 *      0% path as if it were an active failure. Retired rows are now listed
 *      separately and excluded from the gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const MIN_SAMPLE = 5; // below this, don't compute a rate (a cold first session always misses — that is not an anomaly)
const RATIO_SPLIT = 0.25; // median below this => "remainder" convention (measured: the two conventions sit at ~0.001 and ~1.0)

// node:sqlite is experimental and prints an ExperimentalWarning to stderr.
// Swallow that one; let everything else through.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (!(w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message))) console.warn(w);
});

export function windowToMs(spec) {
  const m = /^(\d+)([mhd])$/.exec(String(spec).trim());
  if (!m) throw new Error(`Invalid window format: ${spec} (expected e.g. 60m / 24h / 7d)`);
  const n = Number(m[1]);
  return n * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

export const groupKey = (provider, model) => `${provider}|${model}`;

/**
 * Work out how an upstream reports `usage.input_tokens` — decided PER
 * provider|model, never assumed globally:
 *   remainder: input = the tokens that MISSED; full prefix = input + cache_read
 *   total:     input = the FULL prefix (already includes the hits), so the
 *              cached portion gets counted twice
 *
 * Test: the median of input/cache_read across cache-hit rows. Under
 * `remainder` it is tiny (measured ~0.001); under `total` it approaches or
 * exceeds 1 (measured ~1.09).
 *
 * Getting this wrong turns a 99.9% hit rate into 50%, so it must be decided
 * row by row rather than assumed once.
 *
 * Measured: both conventions coexist inside a single CCR (it depends on the
 * provider and the protocol it is routed over), which is exactly why the
 * decision is per provider|model.
 */
export function inferConvention(samples) {
  const byKey = new Map();
  for (const s of samples) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s.i / s.c);
  }
  const conv = new Map();
  for (const [key, ratios] of byKey) {
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    conv.set(key, median < RATIO_SPLIT ? 'remainder' : 'total');
  }
  return conv;
}

/**
 * Convention validity guard: `total` requires cache_read <= input, because
 * input is supposed to already contain the cached part. Measured: one model on
 * the openai_chat_completions path reported c > i (137%) — under those numbers
 * `total` cannot hold, so fall back to `remainder`.
 *
 * Without this, the rate would be silently clamped to 100% and the real gap
 * hidden — which is exactly what the earlier version did with Math.min(...,100).
 */
export function resolveConvention(inferred, uncached, cached) {
  const convention = inferred || 'remainder';
  if (convention === 'total' && cached > uncached) return { convention: 'remainder', corrected: true };
  return { convention, corrected: false };
}

export function hitRateOf(convention, uncached, cached) {
  const denom = convention === 'total' ? uncached : uncached + cached;
  if (denom <= 0) return null;
  return Math.min((cached / denom) * 100, 100);
}

export function shapeRow(raw, convMap, liveHours, nowMs) {
  const sep = raw.key.indexOf('|');
  const provider = raw.key.slice(0, sep);
  const model = raw.key.slice(sep + 1);
  const { convention, corrected } = resolveConvention(convMap.get(raw.key), raw.uncached, raw.cached);
  const age = raw.lastSeen ? nowMs - Date.parse(raw.lastSeen) : Infinity;
  return {
    key: raw.key,
    provider,
    model,
    requests: raw.requests,
    uncached: raw.uncached,
    cached: raw.cached,
    convention,
    corrected,
    hitRate: raw.cached === 0 ? null : hitRateOf(convention, raw.uncached, raw.cached),
    unsupported: raw.cached === 0,
    live: age <= liveHours * 3600000,
    lastSeen: raw.lastSeen,
  };
}

/**
 * Collapse the many spellings of usage_events.model into one logical name.
 *
 * Measured: the same model appeared under 5 different spellings (with a
 * provider prefix, with a build date, with an expiry note, …), which splits its
 * cost across several groups — summing as-is under-reports.
 *
 * The generic rules strip, in order: provider prefix -> expiry note -> trailing
 * build date -> [1m] marker. Anything the generic rules cannot infer goes in
 * model-aliases.json (the left-hand key is the already-normalized name).
 *
 * Careful: blindly stripping a trailing 4-digit number can misfire (e.g.
 * gpt-4-1106), so an explicit alias always wins over the generic rules.
 */
export function normalizeModel(raw, aliases = new Map()) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const slash = trimmed.lastIndexOf('/');
  let name = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  name = name.replace(/-expires-on-\d+\s*$/i, '').replace(/-\d{4}\s*$/, '').replace(/\[1m\]\s*$/i, '');
  if (aliases.has(name)) return aliases.get(name);
  if (aliases.has(trimmed)) return aliases.get(trimmed);
  return name;
}

const STATUS_LABELS = {
  200: 'success',
  0: 'logging gap (succeeded, status unrecorded)',
  429: 'rate limited',
  499: 'client aborted',
};

function labelFor(status) {
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  if (status >= 500) return 'upstream error';
  if (status >= 400) return 'request error';
  return 'other';
}

/**
 * Status distribution. Key convention: `status_code=0` is a LOGGING GAP, not a
 * failure. Measured: 420 rows with status=0 all carried normal output_tokens
 * (over two days only) — the request succeeded, CCR just did not record the
 * status. Counting them as failures understates a ~90% success rate as 66.7%.
 *
 * So both the failure count and the success-rate denominator exclude status=0,
 * and the gap is reported on its own.
 */
export function summarizeStatus(rows) {
  const byStatus = rows
    .map((r) => ({ status: r.status_code, n: r.n, label: labelFor(r.status_code) }))
    .sort((a, b) => b.n - a.n);
  const sum = (pred) => rows.filter(pred).reduce((s, r) => s + r.n, 0);
  const loggingGap = sum((r) => r.status_code === 0);
  const ok = sum((r) => r.status_code === 200);
  const failed = sum((r) => r.status_code !== 200 && r.status_code !== 0);
  const attempts = ok + failed;
  const top = rows.filter((r) => r.status_code !== 200 && r.status_code !== 0).sort((a, b) => b.n - a.n)[0];
  return {
    byStatus,
    loggingGap,
    ok,
    failed,
    successRate: attempts > 0 ? (ok / attempts) * 100 : 100,
    // Label this explicitly as RAW LOG ROWS. A concurrency burst gives every
    // retry in the batch its own row — measured: 494 rate-limit rows collapsed
    // into only 53 events. Unlabelled, it reads as hundreds of real failures.
    // For the per-event count, see the rateLimit check in ccr-check.
    topFailure: top
      ? `${top.status_code} (${labelFor(top.status_code)}) x${top.n} log rows (concurrency bursts included; see ccr-check for event counts)`
      : null,
  };
}

/**
 * Is this provider/model free? CCR's cost_usd is ESTIMATED from a pricing table
 * (cost_source = models.dev / litellm), and a free provider still gets a
 * positive estimate — so free paths must be declared explicitly, or the report
 * treats free quota as real spend (this once made a free model look like the
 * most expensive one in the fleet).
 *
 * Providers match by PREFIX, because runtime names may carry a suffix, e.g.
 * `myprovider::openai_chat_completions::cred:key-1-1`.
 */
export function isFree(provider, logical, cfg) {
  if (!cfg) return false;
  const p = String(provider || '');
  if ((cfg.freeProviders || []).some((fp) => fp && p.startsWith(fp))) return true;
  return (cfg.freeModels || []).includes(logical);
}

/** Merge tokens and cost across spellings/providers for one logical model.
 *  The hit rate is recomputed from the merged totals — never by averaging ratios. */
export function aggregateByLogicalModel(rows, aliases = new Map(), freeCfg = null) {
  const map = new Map();
  for (const r of rows) {
    const logical = normalizeModel(r.model, aliases);
    if (!map.has(logical)) {
      map.set(logical, { logical, requests: 0, uncached: 0, cached: 0, cost: 0, estimatedCost: 0, free: false, spellings: new Set() });
    }
    const a = map.get(logical);
    const est = r.cost || 0;
    a.requests += r.requests || 0;
    a.uncached += r.uncached || 0;
    a.cached += r.cached || 0;
    a.estimatedCost += est;
    // Keep free-path estimates in their own field (estimatedCost) — they are not billable
    if (!isFree(r.provider, logical, freeCfg)) a.cost += est;
    else a.free = true;
    if (r.model) a.spellings.add(r.model);
  }
  return [...map.values()]
    .map((a) => ({
      ...a,
      spellings: [...a.spellings],
      hitRate: a.cached === 0 ? null : Math.min((a.cached / (a.uncached + a.cached)) * 100, 100),
    }))
    .sort((x, y) => y.requests - x.requests);
}

/** A missing or corrupt config must not take the monitor down — degrade to generic rules only */
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('./model-aliases.json', import.meta.url), 'utf8'));
    return {
      aliases: new Map(Object.entries(raw.aliases || {})),
      free: { freeProviders: raw.free_providers || [], freeModels: raw.free_models || [] },
    };
  } catch {
    return { aliases: new Map(), free: { freeProviders: [], freeModels: [] } };
  }
}

function parseArgs(argv) {
  const out = { window: '24h', threshold: 50, liveHours: 24, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--window') out.window = argv[++i];
    else if (a === '--threshold') out.threshold = Number(argv[++i]);
    else if (a === '--live-hours') out.liveHours = Number(argv[++i]);
  }
  return out;
}

function locateDb() {
  const candidates = [
    process.env.CCR_HOME && path.join(process.env.CCR_HOME, 'usage.sqlite'),
    path.join(process.env.APPDATA || '', 'claude-code-router', 'usage.sqlite'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'claude-code-router', 'usage.sqlite'),
    path.join(os.homedir(), 'Library', 'Application Support', 'claude-code-router', 'usage.sqlite'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function collect(dbPath, sinceIso) {
  // readOnly so this never disturbs a running CCR (no writes, no checkpoint)
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const series = db
      .prepare(
        `SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
                model,
                COUNT(*)                            AS requests,
                SUM(COALESCE(input_tokens, 0))      AS uncached,
                SUM(COALESCE(cache_read_tokens, 0)) AS cached,
                SUM(COALESCE(cost_usd, 0))          AS cost,
                MAX(created_at)                     AS last_seen
           FROM usage_events
          WHERE created_at >= ?
            AND model IS NOT NULL
            AND TRIM(model) <> ''
          GROUP BY provider, model
          ORDER BY (SUM(COALESCE(input_tokens,0)) + SUM(COALESCE(cache_read_tokens,0))) DESC`
      )
      .all(sinceIso);
    // Sample the cache-hit rows so the convention can be decided per row (see inferConvention)
    const samples = db
      .prepare(
        `SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
                model, input_tokens AS i, cache_read_tokens AS c
           FROM usage_events
          WHERE created_at >= ? AND cache_read_tokens > 0 AND input_tokens > 0
          ORDER BY created_at DESC LIMIT 4000`
      )
      .all(sinceIso);
    const statusRows = db
      .prepare(
        `SELECT status_code, COUNT(*) AS n
           FROM usage_events
          WHERE created_at >= ?
          GROUP BY status_code
          ORDER BY n DESC`
      )
      .all(sinceIso);
    return {
      series: series.map((r) => ({
        key: groupKey(r.provider, r.model),
        provider: r.provider,
        model: r.model,
        requests: r.requests,
        uncached: r.uncached,
        cached: r.cached,
        cost: r.cost,
        lastSeen: r.last_seen,
      })),
      samples: samples.map((r) => ({ key: groupKey(r.provider, r.model), i: r.i, c: r.c })),
      statusRows,
    };
  } finally {
    db.close();
  }
}

const fmtRate = (r) => (r.unsupported ? 'n/a' : r.hitRate === null ? '—' : `${r.hitRate.toFixed(1)}%`);

function printTable(title, rows) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  const w = Math.max(9, ...rows.map((r) => r.provider.length));
  const m = Math.max(5, ...rows.map((r) => r.model.length));
  console.log(
    `  ${'provider'.padEnd(w)}  ${'model'.padEnd(m)}  ${'reqs'.padStart(6)}  ${'uncached tok'.padStart(12)}  ${'cached tok'.padStart(12)}  ${'hit rate'.padStart(8)}  last seen`
  );
  for (const r of rows) {
    const notes = [];
    if (r.unsupported) notes.push('upstream has no prefix cache');
    else if (r.corrected) notes.push('convention fell back to remainder (validity check)');
    else if (r.convention === 'total') notes.push('input_tokens includes cached tokens');
    console.log(
      `  ${r.provider.padEnd(w)}  ${r.model.padEnd(m)}  ${String(r.requests).padStart(6)}  ${String(r.uncached).padStart(11)}  ${String(r.cached).padStart(12)}  ${fmtRate(r).padStart(7)}  ${(r.lastSeen || '').slice(5, 16)}${notes.length ? '  <- ' + notes.join('; ') : ''}`
    );
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  // created_at is ISO8601 UTC (with Z); toISOString keeps string comparison valid
  const sinceIso = new Date(Date.now() - windowToMs(args.window)).toISOString();
  const nowMs = Date.now();

  const dbPath = locateDb();
  if (!dbPath) {
    console.error('ERROR: CCR usage.sqlite not found (CCR not installed, or never run)');
    process.exit(0);
  }

  let rows, logical, health;
  try {
    const { series, samples, statusRows } = collect(dbPath, sinceIso);
    const conv = inferConvention(samples);
    const { aliases, free } = loadConfig();
    rows = series
      .filter((r) => r.requests >= MIN_SAMPLE)
      .map((r) => shapeRow(r, conv, args.liveHours, nowMs));
    logical = aggregateByLogicalModel(series.filter((r) => r.requests >= MIN_SAMPLE), aliases, free);
    health = summarizeStatus(statusRows);
  } catch (e) {
    console.error(`ERROR: failed to read usage.sqlite: ${e.message}`);
    process.exit(0); // the monitor itself must not go red just because it cannot read data
  }

  const live = rows.filter((r) => r.live);
  const retired = rows.filter((r) => !r.live);
  // The gate only looks at live paths: a retired path at 0% is history, not a current fault
  const below = live.filter((r) => !r.unsupported && r.hitRate !== null && r.hitRate < args.threshold);

  if (args.json) {
    console.log(
      JSON.stringify({ ok: below.length === 0, window: args.window, threshold: args.threshold, liveHours: args.liveHours, below: below.map((r) => r.key), rows, logical, health })
    );
    process.exit(below.length === 0 ? 0 : 1);
  }

  console.log(`Prompt cache hit rate (window ${args.window}, threshold ${args.threshold}%, min sample ${MIN_SAMPLE}, live = seen within ${args.liveHours}h)`);
  console.log(`source: ${dbPath}`);

  if (rows.length === 0) {
    console.log('\n(not enough requests in window)');
    process.exit(0);
  }

  printTable('LIVE PATHS', live);
  if (retired.length > 0) printTable(`RETIRED PATHS (no traffic in the last ${args.liveHours}h — excluded from the gate)`, retired);

  const supported = live.filter((r) => !r.unsupported && r.hitRate !== null);
  if (supported.length > 0) {
    const totCached = supported.reduce((s, r) => s + r.cached, 0);
    const totAll = supported.reduce((s, r) => s + r.cached + r.uncached, 0);
    console.log(`\nOverall hit rate across live, cache-capable paths: ${((totCached / totAll) * 100).toFixed(1)}%`);
  }

  // Group by logical model: merging spellings and providers is what makes the cost picture complete
  console.log('\nBY LOGICAL MODEL (merges provider prefixes, build dates, aliases)');
  const lw = Math.max(6, ...logical.map((a) => a.logical.length));
  console.log(`  ${'model'.padEnd(lw)}  ${'reqs'.padStart(7)}  ${'hit rate'.padStart(8)}  ${'cost USD'.padStart(9)}  notes`);
  for (const a of logical) {
    const rate = a.hitRate === null ? '—' : `${a.hitRate.toFixed(1)}%`;
    const cost = a.free ? 'free' : a.cost.toFixed(2);
    const notes = [];
    if (a.free && a.estimatedCost > 0) notes.push(`price-table estimate $${a.estimatedCost.toFixed(2)} (not billed)`);
    if (a.spellings.length > 1) notes.push(a.spellings.join(' + '));
    console.log(`  ${a.logical.padEnd(lw)}  ${String(a.requests).padStart(7)}  ${rate.padStart(7)}  ${cost.padStart(9)}  ${notes.join('; ')}`);
  }
  const billable = logical.filter((a) => !a.free).reduce((s, a) => s + a.cost, 0);
  const freeEstimate = logical.filter((a) => a.free).reduce((s, a) => s + a.estimatedCost, 0);
  console.log(`\n  Billable total: $${billable.toFixed(2)} (estimated by CCR from a pricing table — NOT a bill)`);
  if (freeEstimate > 0) console.log(`  Free-path price-table estimate: $${freeEstimate.toFixed(2)} (not actually billed; excluded from the total above)`);

  // Status health: status=0 is a logging gap, not a failure — it must be called out or the success rate is wrong
  console.log('\nSTATUS & HEALTH');
  for (const r of health.byStatus) {
    console.log(`  ${String(r.status).padStart(4)}  ${r.label.padEnd(22)} ${String(r.n).padStart(6)}`);
  }
  console.log(`  Success rate (logging gap excluded): ${health.successRate.toFixed(1)}%  = ${health.ok} / ${health.ok + health.failed}`);
  if (health.loggingGap > 0) {
    console.log(`  WARN: logging gap — ${health.loggingGap} row(s) with status=0 (succeeded but status unrecorded); excluded from failures and the success rate`);
  }
  if (health.topFailure) console.log(`  Top failure: ${health.topFailure}`);

  if (below.length > 0) {
    console.log(`\nWARN: ${below.length} live path(s) below ${args.threshold}%:`);
    below.forEach((r) => console.log(`  ${r.provider} / ${r.model} → ${r.hitRate.toFixed(1)}%`));
    console.log('Hint: check whether injected system-prompt files drifted — prefix drift is the #1 cause of a sudden hit-rate drop.');
    process.exit(1);
  }

  console.log('\nOK: every live path meets the threshold');
  process.exit(0);
}

// Run main() only when executed directly; when imported (by tests) export the pure functions only
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
