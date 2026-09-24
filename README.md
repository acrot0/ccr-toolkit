# ccr-toolkit

Five read-only audit tools for [Claude Code Router](https://github.com/musistudio/claude-code-router) (CCR).

They answer five questions CCR itself does not:

1. **Why did that request fail?** → `ccr-doctor`
2. **Where exactly did it fail?** → `ccr-trace`
3. **Is my prompt cache actually working?** → `ccr-cache`
4. **Is my gateway config healthy?** → `ccr-check`
5. **Will CCR silently overwrite my agent's config with a broken snapshot?** → `ccr-takeover`

All five are **read-only**. They open databases with `readOnly: true` and never write to your config.

---

## Why this exists

CCR is a local model gateway. It routes Claude Code (and other agents) through whichever upstream you configure. Five problems are invisible from inside it:

### 0. The error message is empty, and the explanation is sitting right there

CCR logs every request to `request-logs.sqlite`. When a request fails it records
the upstream's response in `response_body_text` — and then never reads it. The
`error` column it shows you is a different thing entirely, and is frequently
blank.

Measured on a real install: three of seven failures carried an empty `error`
column, while the upstream's actual explanation — *"Can only get item pairs from
a mapping"*, *"请求包含未知字段"*, *"请求过于频繁"* — sat unread in the body.

`ccr-doctor` reads the body, names the fault, and tells you what to do about it:

```
#2450  2026-09-24T11:57:38Z  [tierflow::openai_chat_completions]  HTTP 400  → tool-pairing
      cause:  An assistant turn carries a tool_use with no matching tool_result (an orphaned block).
      action: The upstream rejects unpaired tool blocks. A gateway-side cleaner that strips or
              re-pairs them fixes this — check whether one is installed and whether it is
              enabled for this provider.
      upstream said: "The provided messages input is invalid. The error info is
                      [Can only get item pairs from a mapping.]."
```

It also answers the two questions that make a gateway look flaky when it is not:

- **Did the model name survive routing?** CCR sometimes resolves to an internal
  `<provider>::<protocol>/<model>` form. Anything keying off the model string —
  cache identity, pricing, per-model routing — silently stops matching.
- **Is the cache actually regressing?** A miss is invisible: the request
  succeeds either way, only the bill differs. But most "cache is broken" reports
  are wrong, because a *new session* is supposed to start cold. `ccr-doctor`
  only flags a regression when the prefix stayed the same size and the cache
  vanished anyway. On the machine this was built against, that check reports
  healthy on two paths whose raw hit rates are 98.8% and 90.2% — the naive
  "does the rate flip?" detector called both of them broken.

> **The measured false positives are in the tests.** `test/ccr-doctor.test.mjs`
> carries the exact row sequences that a naive detector gets wrong — the
> 465K-prefix session ending, the fresh 40K session starting — so the check
> cannot regress into crying wolf again.

### 1. The error says *what*; nothing says *where*

Even when a failure does carry a message, it does not tell you which stage of
the gateway produced it. CCR writes a full 7-to-16 hop forensic chain per
request and surfaces none of it. `ccr-trace` reads it — see the [usage
section](#ccr-trace--replay-a-request-through-the-gateway-hop-by-hop) for why
the hop number is the part that tells you what to fix.

### 2. Cache hit rate is a number you can't read

A 0% cache hit rate can look identical to a 99% one — the request succeeds either way, only the bill differs. And the number is easy to misread:

- Some upstreams report `input_tokens` as *the uncached remainder*; others report *the full prefix including cached tokens*. Compute the rate with the wrong convention and 99.9% reads as 50%.
- The same model on two different providers can genuinely differ (one protocol caches, another does not).
- Small requests below the minimum cacheable block always miss — averaging them in drags the rate down and looks like a regression.

`ccr-cache` reads CCR's `usage.sqlite` and reports the rate per `provider|model`, auto-detecting the reporting convention per row.

### 3. Config drift is silent

`ccr-check` catches the failure modes that produce no error message: a fallback mode of `off` (429s go straight to the client), empty model slots, SQLite files that are 98% free pages, and request bodies that CCR folded into a preview (breaking forensics).

### 4. Takeover can break another agent without warning

This is the one with no upstream fix.

When you enable a global-scoped profile, CCR **takes over** that agent's global config file. When you later disable it, CCR restores the file from a backup chain. The restore picks the newest snapshot **that passes CCR's own `isManagedContent` check** — which is not necessarily a *good* one.

If that snapshot is malformed, restoring it silently breaks the agent. The symptom is "my agent randomly stopped working", with no error anywhere.

The behaviour is intentional and the maintainer's answer is "don't use global scope" — see [musistudio/claude-code-router#1575](https://github.com/musistudio/claude-code-router/issues/1575) (open since 2026-07-21). That is not always an option.

`ccr-takeover` audits the backup chain and tells you **which snapshot CCR would pick, and whether it is healthy** — before it bites.

> **Background reading:** [Every time I checked the config file, it was correct. Every time I looked away, it broke again.](docs/why-ccr-reverts-your-config.md)
> — how these rules were reverse-engineered from the bundled `cli.js`, the two that are
> easy to get wrong, and how to check your own setup in 30 seconds.

---

## Install

Requires **Node.js ≥ 22.13** (uses the built-in `node:sqlite`).

> 22.5.0 introduced `node:sqlite`, but it stayed behind `--experimental-sqlite`
> until **22.13.0** — on 22.5–22.12 the imports fail with `ERR_UNKNOWN_BUILTIN_MODULE`
> unless you pass the flag. CI runs 22.13.0 and 24.x to keep this honest.

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

### `ccr-doctor` — why did it fail?

```bash
node src/ccr-doctor.mjs                     # last 7d, 20 failures
node src/ccr-doctor.mjs --since 24h
node src/ccr-doctor.mjs --json              # machine-readable, for CI or a dashboard
node src/ccr-doctor.mjs --limit 100
```

Reads `request-logs.sqlite`, extracts the upstream's own explanation from the
captured response body, and classifies each failure into a named fault with a
concrete next action.

**Failure classes:** `tool-pairing` · `unknown-field` · `rate-limited` ·
`client-abort` · `auth` · `upstream-5xx` · `bad-request` · `opaque`

`opaque` is the one worth watching — it means CCR recorded a failure with
nothing a human can act on. That happens when the body was never captured, or
when it was folded into a preview (bodies over 160KB get an elision marker
spliced into the middle, which is exactly the size of request most likely to
fail). `ccr-check` reports the preview rate; `ccr-doctor` reports the
consequence.

Three checks run alongside the failure list:

| Check | What a warning means |
|---|---|
| `silentFailures` | A large share of failures carried no usable message |
| `cacheStability` | The cache regressed **on an unchanged prefix** — an injected block is being edited between requests. A new session starting cold does *not* trigger this. |
| `modelResolution` | A **successful** request resolved to an internal `<provider>::<protocol>/<model>` id, so anything keying off the model string stops matching |

Exit code `1` only on a `fail`-level finding; warnings do not break automation.

> **Why `cacheStability` is conservative.** The obvious detector — "does the hit
> rate flip on and off?" — flags healthy gateways. Measured against this
> machine: it reported two paths as oscillating whose real hit rates are 98.8%
> and 90.2%. The flips were new sessions legitimately starting cold (a 465K-token
> prefix ending, a fresh 40K one beginning). This check instead compares each
> miss against the last prefix that *did* hit, and only fires when the size
> barely moved. Those exact row sequences are in the test suite.

### `ccr-trace` — replay a request through the gateway, hop by hop

```bash
node src/trace-view.mjs                  # most recent failing request
node src/trace-view.mjs --id 1996
node src/trace-view.mjs --last 5
node src/trace-view.mjs --all            # include successful requests
node src/trace-view.mjs --json
```

CCR writes a full forensic chain per request: measured, a normal call produces
**7 hops** and a rate-limited one that retried four times produces **16**. Each
hop carries the before/after of every field it touched.

```
#2450  HTTP 400  7 hops
  📥  0 [ingress   ] request.ingress                ok        0ms
  📥  1 [ingress   ] gateway.header-normalization   ok        0ms  {remove:/headers/x-api-key, +3}
  🔀  2 [routing   ] router.route-output            ok        0ms  {replace:/body, +4}
  ⏭️   3 [planning  ] fallback.execution-plan        noop      0ms
  ⚙️   4 [capability] provider.capability-routing    ok        0ms  {replace:/body/model, replace:/routing/model}
  📤  5 [attempt   ] upstream.attempt.prepare       ok        1ms  {remove:/headers/content-length, +1}
  ❌  6 [outcome   ] upstream.attempt.outcome       error   796ms → HTTP 400

  ❌ failed at hop 6 (upstream.attempt.outcome) with HTTP 400 — at the upstream call
  🔀 hop 4 rewrote the model: tierflow/tierflow → tierflow::anthropic_messages/tierflow
```

**Why the hop number matters.** A 400 that fails at hop ≤3 was already malformed
before the gateway touched it — a client bug. A 400 at hop 6 left the gateway
intact and came back rejected — a routing or upstream bug. Same status code,
opposite fix, and the error message does not distinguish them.

It also surfaces two things nothing else in the toolchain reads:

- **The model rewrite** — which hop introduced the internal
  `<provider>::<protocol>/<model>` form, so you can tell "my config is wrong"
  from "the gateway transformed it".
- **The retry ladder** — `1s → 2s → 4s` means a capacity problem; no retry at
  all on a 429 means `Router.fallback` is set to `off`. A `network-error` with
  `retryDelayMs: 0` is reported as what it is (a dropped connection), not as a
  backoff that never happened.

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
node src/ccr-takeover-audit.mjs
node src/ccr-takeover-audit.mjs --json
node src/ccr-takeover-audit.mjs --profile myagent=~/.myagent/config.json:zcode
node src/ccr-takeover-audit.mjs --expect-opencode-model your-main-model
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
