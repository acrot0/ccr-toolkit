# ccr-toolkit

Three read-only audit tools for [Claude Code Router](https://github.com/musistudio/claude-code-router) (CCR).

They answer three questions CCR itself does not:

1. **Is my prompt cache actually working?** → `ccr-cache`
2. **Is my gateway config healthy?** → `ccr-check`
3. **Will CCR silently overwrite my agent's config with a broken snapshot?** → `ccr-takeover`

All three are **read-only**. They open databases with `readOnly: true` and never write to your config.

---

## Why this exists

CCR is a local model gateway. It routes Claude Code (and other agents) through whichever upstream you configure. Three problems are invisible from inside it:

### 1. Cache hit rate is a lie you can't see

A 0% cache hit rate can look identical to a 99% one — the request succeeds either way, only the bill differs. And the number is easy to misread:

- Some upstreams report `input_tokens` as *the uncached remainder*; others report *the full prefix including cached tokens*. Compute the rate with the wrong convention and 99.9% reads as 50%.
- The same model on two different providers can genuinely differ (one protocol caches, another does not).
- Small requests below the minimum cacheable block always miss — averaging them in drags the rate down and looks like a regression.

`ccr-cache` reads CCR's `usage.sqlite` and reports the rate per `provider|model`, auto-detecting the reporting convention per row.

### 2. Config drift is silent

`ccr-check` catches the failure modes that produce no error message: a fallback mode of `off` (429s go straight to the client), empty model slots, SQLite files that are 98% free pages, and request bodies that CCR folded into a preview (breaking forensics).

### 3. Takeover can break another agent without warning

This is the one with no upstream fix.

When you enable a global-scoped profile, CCR **takes over** that agent's global config file. When you later disable it, CCR restores the file from a backup chain. The restore picks the newest snapshot **that passes CCR's own `isManagedContent` check** — which is not necessarily a *good* one.

If that snapshot is malformed, restoring it silently breaks the agent. The symptom is "my agent randomly stopped working", with no error anywhere.

The behaviour is intentional and the maintainer's answer is "don't use global scope" — see [musistudio/claude-code-router#1575](https://github.com/musistudio/claude-code-router/issues/1575) (open since 2026-07-21). That is not always an option.

`ccr-takeover` audits the backup chain and tells you **which snapshot CCR would pick, and whether it is healthy** — before it bites.

---

## Install

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
git clone https://github.com/<you>/ccr-toolkit.git
cd ccr-toolkit
npm install        # dev dependency: vitest
```

No runtime dependencies.

> **Windows note.** The repo ships a `.gitattributes` that forces LF. This is
> not cosmetic: with Git for Windows' default `core.autocrlf=true`, a clone
> rewrites line endings to CRLF, and the vitest/esbuild transform then fails
> with `SyntaxError: Invalid or unexpected token` on these files. Verified by
> cloning into a clean directory — LF passes, CRLF fails to parse. Don't remove
> the file.

---

## Usage

### `ccr-cache` — prompt cache hit rate

```bash
node src/cache-monitor.mjs                       # last 24h, threshold 50%
node src/cache-monitor.mjs --window 7d
node src/cache-monitor.mjs --json
node src/cache-monitor.mjs --threshold 80        # exit 1 if a live path is below 80%
```

Exit code `1` if any **live** path (seen in the last `--live-hours`, default 24) is below the threshold — usable as a CI gate.

Retired paths are listed separately and excluded from the gate, so a decommissioned provider at 0% will not fail your build forever.

### `ccr-check` — gateway health

```bash
node src/ccr-check.mjs
node src/ccr-check.mjs --json
```

Checks fallback mode, profile slots, database bloat, request-body preview loss, and `status=0` logging gaps. Exit code `1` on any `fail`-level finding (`warn` does not fail the build).

### `ccr-takeover` — config takeover risk

```bash
node src/ccr-takeover.mjs
node src/ccr-takeover.mjs --json
node src/ccr-takeover.mjs --profile myagent=~/.myagent/config.json:zcode
node src/ccr-takeover.mjs --expect-opencode-model your-main-model
```

Exit code `1` if a snapshot CCR would actually restore is unhealthy.

Profiles are discovered from CCR's own `global-profile-takeover.json` when present, falling back to known locations (`~/.zcode/cli/config.json`, `~/.config/opencode/opencode.jsonc`). Use `--profile` to audit anything else.

> **Note on coverage.** This tool covers agents whose restore predicate is
> `isManagedContent` (zcode-style) or the `x-ccr-client` header check
> (opencode-style). Claude Code's own `settings.json` and Codex's
> `config.toml` use a different mechanism (managed blocks) and are
> **deliberately skipped** — applying zcode's predicate to them would produce
> false verdicts. They are reported as uncovered rather than guessed at.

---

## The rules `ccr-takeover` encodes

Reverse-engineered from CCR's bundled `cli.js` (verified against **v3.1.1**), not guessed:

```
apply(file, {isManagedContent})        // does CCR touch this file at all?
  if (exists && !isManagedContent(cur)) return {changed:false}   // bail, leave it alone
  let o = pickRestore(file, isManagedContent)

pickRestore(file, check)               // choose the restore source
  for (r of [...listBackups(file).reverse(), `${file}.ccr-original`])
    if (!exists(r)) continue
    if (!check(read(r))) return {content: read(r), file: r}      // first one that passes

listBackups(file)                      // NOTE: exact startsWith prefix
  readdir(dir).filter(n => n.startsWith(basename + ".ccr-backup-")).sort()
```

Two consequences that are easy to get wrong:

1. **Only `config.json.ccr-backup-*` participates.** Hand-made backups named `config.json.bak-*` never match `startsWith` and are never selected. Conversely, a backup you name `.ccr-backup-…` *will* become the preferred restore source — naming a backup can accidentally weaponise it.
2. **A snapshot must pass `isManagedContent` to be eligible.** So "the hooks are broken" does not mean "there is a threat" — it must *also* be managed. An unmanaged broken file is inert.

Both rules have unit tests that will fail if someone changes them.

---

## Tests

```bash
npm test
```

103 tests. Each one locks a rule that was learned from a real misdiagnosis — the failure modes they encode all produced *silent* wrong answers, not crashes:

- `status=0` rows are a logging gap, not failures. Counting them as failures turns a ~90% success rate into 66.7%.
- 429s must be clustered into events. 494 raw log lines were only 53 events; reporting the raw count overstates the problem ~10×.
- A `total`-convention upstream can report `cache_read > input`, which makes `total` impossible — the code falls back to `remainder` instead of silently clamping to 100% and hiding the real gap.

---

## Limitations

- **Read-only by design.** There is no `--fix`. Deciding what a "healthy" config looks like is yours, not the tool's.
- **CCR internals change.** The takeover rules were verified against v3.1.1. If a future version changes `listBackups` or `isManagedContent`, re-verify before trusting the verdict.
- **`node:sqlite` is experimental.** It prints an `ExperimentalWarning`; the tools suppress only that one and pass others through.
- **Not affiliated with CCR.** Independent tooling.

---

## License

MIT
