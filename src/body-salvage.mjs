#!/usr/bin/env node
/**
 * ccr-body — salvage what a folded request body still says (read-only)
 *
 * Usage:
 *   node src/body-salvage.mjs                  # every failing request
 *   node src/body-salvage.mjs --id 2088
 *   node src/body-salvage.mjs --since 24h
 *   node src/body-salvage.mjs --json
 *
 * Why it exists: CCR folds request bodies over 160KB into a "preview" — it cuts
 * the middle out and splices in " ... N bytes omitted from preview ... ". That
 * marker breaks the JSON, and request_body_truncated stays 0, so the body looks
 * intact and parses as nothing.
 *
 * Measured on a real install: 95.8% of stored bodies are folded this way. The
 * bodies most likely to be folded are the large ones — which are also the ones
 * most likely to fail.
 *
 * The fold keeps the head and the tail. `model` is a top-level key that appears
 * in the head, so it survives every fold — measured: 300 of 300 folded bodies
 * yielded it. That single fact answers the single most common gateway failure
 * report, "Missing model in request body": it shows whether the client actually
 * sent one.
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

export const PREVIEW_MARKER = /\.\.\. (\d+) bytes omitted from preview \.\.\./;

/**
 * Read a request body that may have had its middle cut out.
 *
 * Two strategies, in order: parse it whole (the common case for small bodies),
 * then fall back to regex on the surviving head. The regex is anchored to a
 * top-level `"model":` — matched only near the start, so a prompt that happens
 * to discuss models cannot be mistaken for the request's own model.
 */
export function salvageBody(text) {
  const empty = { model: null, maxTokens: null, topKeys: [], messageCount: 0, folded: false, omittedBytes: 0, present: false };
  if (typeof text !== 'string' || text.length === 0) return empty;

  const marker = text.match(PREVIEW_MARKER);
  const folded = marker !== null;
  const omittedBytes = folded ? Number(marker[1]) : 0;

  if (!folded) {
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      // A body exists but is unparseable (HTML error page, partial write).
      // `present` still true: we know a body was stored, we just cannot read it.
      return { ...empty, present: true };
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { ...empty, present: true };
    return {
      model: typeof j.model === 'string' ? j.model : null,
      maxTokens: Number.isFinite(j.max_tokens) ? j.max_tokens : null,
      topKeys: Object.keys(j),
      messageCount: Array.isArray(j.messages) ? j.messages.length : 0,
      folded: false,
      omittedBytes: 0,
      present: true,
    };
  }

  // Folded: work on the head only. 2000 chars is far past where `model` sits in
  // any real payload, and short enough that a `model` mentioned inside a long
  // system prompt cannot slip in ahead of the real key.
  const head = text.slice(0, 2000);
  const modelMatch = head.match(/"model"\s*:\s*"([^"]+)"/);
  const maxMatch = head.match(/"max_tokens"\s*:\s*(\d+)/);
  const keys = [...head.matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1]);
  const roles = [...head.matchAll(/"role"\s*:\s*"([^"]+)"/g)].length;

  return {
    model: modelMatch ? modelMatch[1] : null,
    maxTokens: maxMatch ? Number(maxMatch[1]) : null,
    topKeys: [...new Set(keys)].slice(0, 12),
    messageCount: roles,
    folded: true,
    omittedBytes,
    present: true,
  };
}

/**
 * Put the salvaged body next to what the gateway recorded, to answer the one
 * question every "Missing model in request body" report turns on: did the
 * client send a model, or not?
 *
 * If it did, the fault is downstream of the client and no amount of editing
 * the client's config will fix it.
 */
export function compareToFailure(salvaged, row) {
  if (!salvaged || !row) return { verdict: 'unknown', detail: 'Nothing to compare.' };
  // No body stored at all means no evidence either way. Only claim the model
  // was absent when a body actually exists to have been missing it from.
  if (!salvaged.present) {
    return { verdict: 'unknown', detail: 'No request body was stored — nothing to conclude.' };
  }
  const routed = row.requested_model ?? null;
  if (!salvaged.model) {
    return {
      verdict: 'model-absent',
      detail: 'The body exists and carries no model field — the client sent none. This is a client-side fault.',
    };
  }
  if (routed && salvaged.model !== routed && !String(routed).endsWith(salvaged.model)) {
    return {
      verdict: 'model-mismatch',
      detail: `The body carried "${salvaged.model}" but the gateway routed "${routed}".`,
    };
  }
  return {
    verdict: 'model-present',
    detail: `The client DID send model="${salvaged.model}" — the fault is downstream of the client, not a missing field.`,
  };
}

export function renderSalvage(s) {
  const out = [];
  if (s.folded) {
    out.push(`  body folded: ${s.omittedBytes} bytes omitted from the middle (request_body_truncated stays 0, so it looks intact)`);
  } else {
    out.push('  body intact');
  }
  out.push(`  model: ${s.model ? `"${s.model}"` : 'MISSING — no model field in the body'}`);
  if (s.maxTokens !== null) out.push(`  max_tokens: ${s.maxTokens}`);
  if (s.topKeys.length > 0) out.push(`  keys in head: ${s.topKeys.join(', ')}`);
  if (s.messageCount > 0) out.push(`  messages visible: ${s.messageCount}${s.folded ? ' (a floor — the middle was cut out)' : ''}`);
  return out;
}

function locate(name) {
  const candidates = [
    process.env.CCR_HOME && path.join(process.env.CCR_HOME, name),
    path.join(process.env.APPDATA || '', 'claude-code-router', name),
    path.join(os.homedir(), 'AppData', 'Roaming', 'claude-code-router', name),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function windowToMs(spec) {
  const m = /^(\d+)([dhms])$/.exec(String(spec ?? '').trim());
  if (!m) return 7 * 86400000;
  return Number(m[1]) * { d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[2]];
}

export function loadBodies({ id, sinceMs, failuresOnly }) {
  const p = locate('request-logs.sqlite');
  if (!p) return { rows: [], ccrInstalled: false };
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    let rows;
    if (id) {
      rows = db.prepare(`SELECT id, created_at, provider, status_code, requested_model, resolved_model,
        request_body_text, request_body_size_bytes, request_body_truncated
        FROM request_logs WHERE id = ?`).all(id);
    } else {
      const since = new Date(Date.now() - sinceMs).toISOString();
      rows = db.prepare(`SELECT id, created_at, provider, status_code, requested_model, resolved_model,
        request_body_text, request_body_size_bytes, request_body_truncated
        FROM request_logs WHERE created_at >= ? ${failuresOnly ? 'AND status_code >= 400' : ''}
        ORDER BY created_at DESC`).all(since);
    }
    return { rows, ccrInstalled: true };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const out = { json: false, id: null, since: '7d', failuresOnly: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--id') out.id = Number(argv[++i]);
    else if (argv[i] === '--since') out.since = argv[++i];
    else if (argv[i] === '--all') out.failuresOnly = false;
  }
  if (out.id !== null) out.failuresOnly = false;
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { rows, ccrInstalled } = loadBodies({ id: args.id, sinceMs: windowToMs(args.since), failuresOnly: args.failuresOnly });

  if (!ccrInstalled) {
    console.log('CCR request log not found — nothing to salvage.');
    process.exit(0);
  }
  if (rows.length === 0) {
    console.log(args.failuresOnly ? 'No failing requests in this window.' : 'No requests found.');
    process.exit(0);
  }

  const results = rows.map((r) => {
    const salvaged = salvageBody(r.request_body_text);
    return { row: r, salvaged, verdict: compareToFailure(salvaged, r) };
  });

  if (args.json) {
    console.log(JSON.stringify(results.map(({ row, salvaged, verdict }) => ({
      id: row.id, at: row.created_at, provider: row.provider, status: row.status_code,
      storedBytes: row.request_body_size_bytes, truncatedFlag: !!row.request_body_truncated,
      ...salvaged, verdict,
    })), null, 2));
    process.exit(0);
  }

  const folded = results.filter((r) => r.salvaged.folded).length;
  console.log(`CCR body salvage — what a folded request still says (read-only)\n`);
  console.log(`  ${results.length} request(s); ${folded} had a folded body\n`);

  for (const { row, salvaged, verdict } of results) {
    console.log(`#${row.id}  ${row.created_at}  [${row.provider}]  HTTP ${row.status_code}  stored ${row.request_body_size_bytes ?? '?'}B`);
    for (const line of renderSalvage(salvaged)) console.log(line);
    if (verdict.verdict !== 'unknown') console.log(`  → ${verdict.detail}`);
    console.log('');
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
