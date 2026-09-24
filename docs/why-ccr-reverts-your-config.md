# Every time I checked the config file, it was correct. Every time I looked away, it broke again.

I use Claude Code Router (CCR) as a local gateway in front of several model providers. It's a good tool. It also, by design, rewrites other agents' config files — and when it does that, it can break them with no error message anywhere.

This is how I tracked that down, and the two rules I had to reverse-engineer from a minified Electron app to build something that warns me before it bites. The tool is [ccr-toolkit](https://github.com/acrot0/ccr-toolkit). The method is the interesting part.

---

## The symptom: an agent that randomly stops working

I run three agents against the same gateway: Claude Code, plus zcode and opencode for side work.

Every so often, zcode's shell would just… die. Not crash — every Bash call would fail. Restart it, and everything was fine again.

No error message. No log line. The config file looked correct every time I opened it.

That last part is the tell. **If a file looks correct when you inspect it but the system misbehaves, something is rewriting it between your inspections.**

---

## First hypothesis (wrong): a bad hook

The failing agent had a `PreToolUse` hook pointing at a script path. That script had been moved in a cleanup. A hook pointing at a missing file exits non-zero, and a non-zero `PreToolUse` hook blocks the tool call — which is exactly the "every Bash call fails" symptom.

Clean hypothesis. Correct mechanism. **Wrong culprit.**

I fixed the path. The failures stopped. Then they came back, and the path was broken again. This happened six times before I stopped treating it as a one-off.

A file that reverts to a broken state after you fix it is not a file with a bug. It's a file with an owner.

---

## Finding the owner

CCR is an Electron app, so its logic lives in `app.asar`. Extracting it is mechanical:

```js
import fs from 'node:fs';
const b = fs.readFileSync('resources/app.asar');
const headerSize = b.readUInt32LE(12);
const header = JSON.parse(b.slice(16, 16 + headerSize).toString('utf8'));
// then index into the file table and slice out what you want
```

Inside `dist/main/cli.js` I found the answer, and it came with a surprise: **the mechanism wasn't a bug at all.**

Here is the logic that was overwriting my fix. It decides whether to touch a config file, and if so, which backup to restore from:

```js
// Decide whether CCR touches this file at all
function apply(file, { isManagedContent }) {
  if (exists(file) && !isManagedContent(read(file))) return { changed: false };  // bail out
  let o = pickRestore(file, isManagedContent);
  ...
}

// Choose which backup to restore from
function pickRestore(file, check) {
  for (const r of [...listBackups(file).reverse(), `${file}.ccr-original`]) {
    if (!exists(r)) continue;
    if (!check(read(r))) return { content: read(r), file: r };  // first one that passes
  }
}

// List backups — note the exact prefix
function listBackups(file) {
  return readdir(dirname(file))
    .filter(n => n.startsWith(basename(file) + '.ccr-backup-'))
    .sort();
}
```

> **On the names:** the shipped bundle is minified, so these functions are actually called things like `yFe` and `hFe`. I've renamed them to what they do. The *behaviour* is verbatim — I checked each line against the bundle.

So: CCR writes a managed block into the agent's global config when a global-scoped profile is enabled. When that profile is disabled, it **restores the file from a backup chain**, picking the newest snapshot that passes an ownership check.

The snapshots included one from before my cleanup — hooks pointing at a script that no longer existed. CCR kept restoring it over my fix.

---

## Two rules that are easy to get wrong

Reading that code carefully changed my mental model twice. Both times, the wrong version had felt obvious.

### Rule 1: only one naming pattern participates

`listBackups` uses `startsWith(basename + '.ccr-backup-')`. Not a glob. Not a suffix match.

So a safety copy named `config.json.bak-2026-09-23` never matches. CCR doesn't know it exists.

**The inverse is the dangerous part.** The list is `.sort()`-ed with no comparator — plain lexicographic order — and `pickRestore` reverses it. So the first candidate is whichever filename sorts last, *not* whichever was written most recently.

Any file I name `config.json.ccr-backup-…` therefore becomes a preferred restore source, and a lexicographically-larger name wins.

I found this out the hard way. I made a backup before an edit and named it `config.json.ccr-backup-….bak-cc-20260922` — I'd used the prefix out of habit, then appended a suffix. It sorted first. **My own backup immediately became the thing CCR would restore from**, and I had effectively manufactured a new bad snapshot while trying to protect against one.

I only caught it because I was auditing the chain. Nothing warns you.

### Rule 2: "broken" is not the same as "dangerous"

The ownership check is real:

```js
function isManagedContent(text, providerId) {
  const cfg = JSON.parse(text);
  if (cfg.provider?.[providerId]) return true;
  if (cfg.model?.main?.startsWith(`${providerId}/`)) return true;
  if (cfg.providers?.some(p => p.id === providerId)) return true;
  return false;
}
```

A snapshot only qualifies for restore **if it passes this check**. So a snapshot can be badly broken — hooks pointing at deleted files, missing events entirely — and still be completely inert, because CCR would never select it.

I had counted 17 broken snapshots and considered them all threats. **The real number of live threats was 11**, and I only got there by checking both conditions. Reporting the wrong number would have sent me deleting files that were harmless while potentially missing the ones that mattered.

This is the kind of error that doesn't announce itself. Both numbers are plausible. Only one is actionable.

---

## Turning it into a tool

Once the rules were explicit, the tool was straightforward: walk the backup chain the way CCR does, apply the same predicates, report what it *would* pick and whether that snapshot is healthy.

```
$ node src/ccr-takeover-audit.mjs

── zcode (zcode) ──
  file       : ~/.zcode/cli/config.json
  CCR manages: yes (reads & writes this file)
  live health: ok
  candidates : 11
  REAL THREATS: 0
  would restore from: config.json.ccr-backup-2026-09-23T16-16-55-945Z
  picked is healthy : yes
  OK: no threat
```

And with a deliberately broken fixture, it catches it:

```
  REAL THREATS: 1  <- a bad snapshot CCR would pick
      !! config.json.ccr-backup-2026-01-01T00-00-00-000Z  (missing SessionStart,PostToolUse,Stop)
  picked is healthy : NO — restoring it breaks the agent
  THREAT: fix required
```

Exit code 1 on a real threat, so it can gate CI.

---

## Upstream says this is intentional

I filed my findings against the existing issue rather than opening a new one. [musistudio/claude-code-router#1575](https://github.com/musistudio/claude-code-router/issues/1575) describes exactly this, and it's been open since July 2026.

The maintainer's response is clear and reasonable from their side: taking over the global config is *the point* of a global-scoped profile, and the answer is "switch the profile scope away from global."

That's a legitimate design decision. It also isn't always available — some workflows need the global scope — and it doesn't change the fact that the failure mode is silent. The tool exists for that gap.

I checked whether a later release fixed it. [#1769](https://github.com/musistudio/claude-code-router/pull/1769) did fix a config-loss bug in the *Claude App* restore path, closed 2026-09-10. But that's a different code path from the zcode/opencode profile restore. I re-extracted `cli.js` from v3.1.1 and confirmed `listBackups` and `isManagedContent` are unchanged.

**Worth saying plainly: I was not looking at a bug. I was looking at documented-by-source-code behaviour with an undocumented failure mode.** The tool makes the failure mode legible. It does not argue with the design.

---

## What generalizes beyond this tool

Three things I'd carry to the next one of these:

**1. "Looks correct when I check" means something rewrites it.** A file that reverts after you fix it has an owner. Find the owner before fixing anything else.

**2. When the source is available, read the selection logic, not just the failure.** The decompiled code told me two things a bug report never would have: which files participate, and that eligibility is conditional. Both changed my conclusions.

**3. Count the *actionable* set, not the alarming one.** 17 broken files was the scary number. 11 eligible-and-broken was the useful one. The gap between them is where wasted work lives — in this case, deleting harmless files while the real risk went unaddressed.

---

## The tool

[github.com/acrot0/ccr-toolkit](https://github.com/acrot0/ccr-toolkit) — MIT, zero runtime dependencies, 104 tests.

Three read-only checks:
- `ccr-takeover` — which config CCR would restore, and whether that snapshot is healthy
- `ccr-cache` — prompt cache hit rate per provider|model, with automatic reporting-convention detection
- `ccr-check` — gateway health: fallback mode, model slots, database bloat, logging gaps

All three open their databases read-only and never write to your config. There is no `--fix` — deciding what a healthy config looks like is yours.

---

## Check yours in 30 seconds

If you run CCR with a global-scoped profile, you can see the risk without installing anything. Two commands:

```bash
# 1. Which profiles has CCR taken over?
cat ~/AppData/Roaming/claude-code-router/global-profile-takeover.json  # Windows
# cat ~/Library/Application\ Support/claude-code-router/global-profile-takeover.json  # macOS

# 2. What snapshots exist for one of them, and which would be picked?
ls -1 ~/.zcode/cli/config.json.ccr-backup-* | sort | tail -1
```

That last filename is what CCR restores from when the profile is disabled. **Open it and check the hooks point at files that still exist.**

If they don't, you have a latent version of exactly the failure in this post — it just hasn't fired yet.
