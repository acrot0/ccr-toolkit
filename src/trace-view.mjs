#!/usr/bin/env node
/**
 * trace-view — replay a request's route through the gateway, hop by hop
 *
 * Usage:
 *   node src/trace-view.mjs                # most recent failing request
 *   node src/trace-view.mjs --id 1996
 *   node src/trace-view.mjs --last 5
 *   node src/trace-view.mjs --json
 *
 * Why it exists: CCR records a complete forensic chain for every request —
 * measured, a normal call writes 7 hops (ingress snapshot, header
 * normalization, route output, fallback plan, capability routing, attempt
 * prepare, attempt outcome) and a retried one writes 16. Each hop carries the
 * before/after of every field it touched.
 *
 * The failure itself is one line in that chain, and reading it answers the
 * question the error message does not: which hop broke it. A 400 whose body was
 * already malformed on arrival is a client bug; a 400 after the gateway rewrote
 * the model id is a routing bug. Same status code, opposite fix.
 *
 * Read-only.
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

export function parseTrace(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.hops)) return null;
  return j;
}

export function timeline(hops) {
  return (hops ?? []).map((h) => ({
    seq: h.seq,
    phase: h.phase,
    name: h.name,
    status: h.status,
    ms: h.durationMs,
    changes: (h.changes ?? []).map((c) => `${c.operation}:${c.path}`),
  }));
}

/**
 * The hop where the upstream call failed.
 *
 * When a request retried, EVERY attempt fails — the earlier ones were
 * superseded, not decisive. Report the last one: that is the status the client
 * actually received.
 */
export function failureHop(hops) {
  const failed = (hops ?? []).filter((h) => h.status === 'error');
  if (failed.length === 0) return null;
  const last = failed[failed.length - 1];
  return {
    seq: last.seq,
    name: last.name,
    phase: last.phase,
    status: last.status,
    statusCode: last.outcome?.statusCode ?? null,
  };
}

/**
 * Follow the model name across the hops that rewrite it.
 *
 * This is where a model id picks up an internal `<provider>::<protocol>/<model>`
 * form. Seeing which hop introduced it is the difference between "the config is
 * wrong" and "the gateway transformed it".
 */
export function modelJourney(hops) {
  const out = [];
  for (const h of hops ?? []) {
    for (const c of h.changes ?? []) {
      if (!/model/.test(c.path ?? '')) continue;
      // A change with no `before` is the client's own model name arriving for
      // the first time (measured: hop 2 replaces the whole body). Reporting
      // that as a rewrite reads as "null → X", which explains nothing.
      if (c.before === undefined) continue;
      out.push({ seq: h.seq, hop: h.name, from: c.before, to: c.after ?? null });
    }
  }
  return out;
}

/**
 * The backoff sequence a rate-limited request climbed.
 *
 * A 429 that retried at 1s/2s/4s and still failed is a capacity problem; a 429
 * that never retried is a config problem (Router.fallback mode=off).
 */
export function retryLadder(hops) {
  const out = [];
  for (const h of hops ?? []) {
    const d = h.outcome?.retryDelayMs;
    // retryDelayMs is present but 0 on failures the gateway never retried —
    // measured: {fallbackReason: "network-error", retryDelayMs: 0}. Counting
    // those as retries invents a backoff that did not happen.
    if (typeof d !== 'number' || d <= 0) continue;
    out.push({ seq: h.seq, delayMs: d, statusCode: h.outcome?.statusCode ?? null });
  }
  return out;
}

/**
 * Why the gateway gave up, when the answer is not an HTTP status.
 *
 * A 499 never received a status from the upstream — the `outcome` block is the
 * only place that says what happened, and nothing else in the toolchain reads
 * it.
 */
export function outcomeReason(hops) {
  const failed = (hops ?? []).filter((h) => h.status === 'error');
  if (failed.length === 0) return null;
  const last = failed[failed.length - 1];
  if (last.outcome?.statusCode) return null;
  return last.outcome?.fallbackReason ?? null;
}

const PHASE_ICON = { ingress: '📥', routing: '🔀', planning: '📋', capability: '⚙️ ', attempt: '📤', outcome: '📥' };

export function renderTimeline(hops) {
  const fail = failureHop(hops);
  const ladder = new Map(retryLadder(hops).map((r) => [r.seq, r.delayMs]));
  return (hops ?? []).map((h) => {
    const isFail = fail && h.seq === fail.seq;
    const icon = isFail ? '❌' : h.status === 'noop' ? '⏭️ ' : (PHASE_ICON[h.phase] ?? '  ');
    const ms = h.durationMs !== undefined ? `${h.durationMs}ms` : '';
    const changes = (h.changes ?? []).map((c) => `${c.operation}:${c.path}`);
    const retry = ladder.has(h.seq) ? ` ↻ retry in ${ladder.get(h.seq)}ms` : '';
    const code = isFail && h.outcome?.statusCode ? ` → HTTP ${h.outcome.statusCode}` : '';
    const detail = changes.length > 0 ? `  {${changes.slice(0, 3).join(', ')}${changes.length > 3 ? `, +${changes.length - 3}` : ''}}` : '';
    return `${icon} ${String(h.seq).padStart(2)} [${String(h.phase ?? '').padEnd(10)}] ${String(h.name).padEnd(30)} ${h.status.padEnd(5)} ${ms.padStart(7)}${code}${retry}${detail}`;
  });
}

function locate(name) {
  const candidates = [
    process.env.CCR_HOME && path.join(process.env.CCR_HOME, name),
    path.join(process.env.APPDATA || '', 'claude-code-router', name),
    path.join(os.homedir(), 'AppData', 'Roaming', 'claude-code-router', name),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function loadTraces({ id, last, failuresOnly }) {
  const p = locate('request-logs.sqlite');
  if (!p) return { traces: [], ccrInstalled: false };
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    let rows;
    if (id) {
      rows = db.prepare(`
        SELECT t.request_log_id AS id, t.trace_json, t.complete, t.truncated, t.hop_count,
               l.status_code, l.provider, l.created_at, l.requested_model
          FROM request_route_traces t JOIN request_logs l ON l.id = t.request_log_id
         WHERE t.request_log_id = ?`).all(id);
    } else {
      rows = db.prepare(`
        SELECT t.request_log_id AS id, t.trace_json, t.complete, t.truncated, t.hop_count,
               l.status_code, l.provider, l.created_at, l.requested_model
          FROM request_route_traces t JOIN request_logs l ON l.id = t.request_log_id
         ${failuresOnly ? 'WHERE l.status_code >= 400' : ''}
         ORDER BY l.created_at DESC LIMIT ?`).all(last);
    }
    return { traces: rows, ccrInstalled: true };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const out = { json: false, id: null, last: 1, failuresOnly: true, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--id') out.id = Number(argv[++i]);
    else if (argv[i] === '--last') out.last = Number(argv[++i]);
    else if (argv[i] === '--all') out.all = true;
  }
  out.failuresOnly = !out.all && out.id === null;
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { traces, ccrInstalled } = loadTraces(args);

  if (!ccrInstalled) {
    console.log('CCR request log not found — nothing to trace.');
    process.exit(0);
  }
  if (traces.length === 0) {
    console.log(args.failuresOnly ? 'No failing requests to trace.' : 'No traces found.');
    process.exit(0);
  }

  if (args.json) {
    const out = traces.map((r) => {
      const t = parseTrace(r.trace_json);
      return {
        id: r.id, at: r.created_at, provider: r.provider, status: r.status_code,
        complete: !!r.complete, truncated: !!r.truncated, hopCount: r.hop_count,
        failure: t ? failureHop(t.hops) : null,
        outcomeReason: t ? outcomeReason(t.hops) : null,
        modelJourney: t ? modelJourney(t.hops) : [],
        retryLadder: t ? retryLadder(t.hops) : [],
        timeline: t ? timeline(t.hops) : [],
      };
    });
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  for (const r of traces) {
    const t = parseTrace(r.trace_json);
    console.log(`\n#${r.id}  ${r.created_at}  [${r.provider}]  HTTP ${r.status_code}  ${r.hop_count} hops${r.complete ? '' : '  (INCOMPLETE)'}${r.truncated ? '  (TRUNCATED)' : ''}`);
    if (!t) {
      console.log('  trace unreadable');
      continue;
    }
    for (const line of renderTimeline(t.hops)) console.log('  ' + line);

    const fail = failureHop(t.hops);
    if (fail) {
      const at = fail.seq <= 3 ? 'before the gateway touched it — this is a client-side request bug'
        : fail.seq >= 5 ? 'at the upstream call — the request left the gateway and came back rejected'
          : 'in routing';
      const why = outcomeReason(t.hops);
      const what = fail.statusCode ? `HTTP ${fail.statusCode}` : (why ? why : 'no status');
      console.log(`\n  ❌ failed at hop ${fail.seq} (${fail.name}) with ${what} — ${at}`);
      if (!fail.statusCode && why) {
        console.log(`     The upstream never returned a status; the gateway recorded "${why}".`);
      }
    }

    const journey = modelJourney(t.hops);
    if (journey.length > 0) {
      const seen = new Set();
      for (const j of journey) {
        const key = `${j.from}→${j.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`  🔀 hop ${j.seq} rewrote the model: ${j.from} → ${j.to}`);
      }
    }

    const ladder = retryLadder(t.hops);
    if (ladder.length > 0) {
      console.log(`  ↻ retried ${ladder.length}× with backoff ${ladder.map((l) => l.delayMs + 'ms').join(' → ')}`);
    }
  }
  console.log('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
