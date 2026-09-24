#!/usr/bin/env node
/**
 * ccr-toolkit — one entry point for the whole toolkit
 *
 * Usage:
 *   node src/cli.mjs                  # run every check, summarize
 *   node src/cli.mjs doctor           # one tool, its own output
 *   node src/cli.mjs doctor --json
 *   node src/cli.mjs --list
 *
 * Why it exists: six tools meant six commands to remember, and no way to ask
 * "is anything wrong?" without running all of them. This runs them together and
 * reports the worst level, so it works as a single CI gate.
 *
 * Read-only, like everything else here.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const COMMANDS = {
  doctor: './ccr-doctor.mjs',
  trace: './trace-view.mjs',
  body: './body-salvage.mjs',
  cache: './cache-monitor.mjs',
  check: './ccr-check.mjs',
  takeover: './ccr-takeover-audit.mjs',
};

/** Which tools make sense in a default sweep. `trace` and `body` are deep
 *  dives that need a specific request to be useful, so they stay opt-in. */
export const DEFAULT_SWEEP = ['doctor', 'cache', 'check', 'takeover'];

const LEVELS = { ok: 0, warn: 1, unknown: 1, fail: 2 };

export function resolveCommand(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const bare = name.replace(/^--?/, '');
  return COMMANDS[bare] ?? null;
}

/**
 * Combine per-tool results into one verdict.
 *
 * A tool that could not run is NOT dropped — it becomes `unknown` and is listed
 * under attention. Silently omitting a crashed tool would let the summary claim
 * more coverage than it actually had.
 */
export function summarize(results) {
  const ok = results.filter((r) => r.level === 'ok').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  const failed = results.filter((r) => r.level === 'fail').length;
  const unknown = results.filter((r) => r.level === 'unknown').length;
  const attention = results.filter((r) => r.level !== 'ok');
  const level = results.reduce((acc, r) => (LEVELS[r.level] > LEVELS[acc] ? r.level : acc), 'ok');
  return { level, ok, warned, failed, unknown, attention };
}

function runTool(file, args) {
  const full = path.join(HERE, file.replace(/^\.\//, ''));
  const res = spawnSync(process.execPath, [full, ...args], { encoding: 'utf8' });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 1 };
}

/** Map a tool's own exit code and --json output onto a level. */
function levelOf(code, stdout) {
  try {
    const j = JSON.parse(stdout);
    if (j && typeof j.level === 'string') return j.level;
  } catch { /* not json, fall through */ }
  if (code === 0) return 'ok';
  if (code === 1) return 'fail';
  return 'unknown';
}

function parseArgs(argv) {
  const out = { json: false, list: false, command: null, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--list' || a === '--help' || a === '-h') out.list = true;
    else if (!out.command && resolveCommand(a)) out.command = a.replace(/^--?/, '');
    else out.passthrough.push(a);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.list) {
    console.log('ccr-toolkit — read-only tools for Claude Code Router\n');
    for (const [name, file] of Object.entries(COMMANDS)) {
      const sweep = DEFAULT_SWEEP.includes(name) ? '' : '  (opt-in)';
      console.log(`  ${name.padEnd(10)} ${file}${sweep}`);
    }
    console.log('\n  ccr-toolkit                run the default sweep and summarize');
    console.log('  ccr-toolkit <tool> [...]   run one tool with its own flags');
    process.exit(0);
  }

  // Single tool: hand over completely, including stdout and exit code.
  if (args.command) {
    const res = runTool(COMMANDS[args.command], args.passthrough);
    process.stdout.write(res.stdout);
    process.stderr.write(res.stderr);
    process.exit(res.code);
  }

  // Sweep.
  const results = [];
  for (const name of DEFAULT_SWEEP) {
    const res = runTool(COMMANDS[name], ['--json']);
    results.push({ name, level: levelOf(res.code, res.stdout), code: res.code, stdout: res.stdout });
  }
  const s = summarize(results);

  if (args.json) {
    console.log(JSON.stringify({
      level: s.level, ok: s.ok, warned: s.warned, failed: s.failed, unknown: s.unknown,
      tools: results.map(({ name, level, code }) => ({ name, level, code })),
    }, null, 2));
    process.exit(s.level === 'fail' ? 1 : 0);
  }

  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌', unknown: '❓' };
  console.log('CCR toolkit — full sweep (read-only)\n');
  for (const { name, level } of results) console.log(`  ${icon[level]} ${name.padEnd(10)} ${level.toUpperCase()}`);
  console.log(`\n  ${s.ok} ok, ${s.warned} warn, ${s.failed} fail${s.unknown ? `, ${s.unknown} unknown` : ''}`);

  if (s.attention.length > 0) {
    console.log('\n  Needs attention:');
    for (const a of s.attention) console.log(`    ccr-toolkit ${a.name}`);
    console.log('\n  Run one on its own for the full detail, e.g. `ccr-toolkit doctor`.');
  }
  console.log(`\n  Overall: ${icon[s.level]} ${s.level.toUpperCase()}`);
  process.exit(s.level === 'fail' ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
