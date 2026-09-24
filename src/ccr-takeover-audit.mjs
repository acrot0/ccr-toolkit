#!/usr/bin/env node
/**
 * ccr-takeover-audit — audit which config files CCR would silently restore,
 * and whether the snapshot it would pick is broken.
 *
 * THE PROBLEM
 * -----------
 * Claude Code Router "takes over" the global config of other agents
 * (zcode, opencode, …) when a global-scoped profile is enabled. On disable,
 * it restores that file from a backup chain. Two things make this dangerous:
 *
 *   1. The restore picks the *newest* snapshot that passes CCR's own
 *      `isManagedContent` check — not the newest snapshot, period.
 *   2. If that snapshot is malformed (e.g. hooks pointing at a hook file that
 *      no longer exists), restoring it silently breaks the agent. The failure
 *      looks like "my agent randomly stopped working", with no error.
 *
 * This has no upstream fix: the behaviour is intentional (see
 * musistudio/claude-code-router#1575, still open), and the author's answer is
 * "switch the profile scope away from global". That is not always possible.
 * This tool is a read-only audit so you can see the risk before it bites.
 *
 * THE RULES (reverse-engineered from CCR's bundled cli.js, not guessed)
 * ---------------------------------------------------------------------
 *   apply(file, {isManagedContent})          // whether CCR touches this file
 *     if (exists && !isManagedContent(cur)) return {changed:false}   // bail out
 *     let o = pickRestore(file, isManagedContent)
 *
 *   pickRestore(file, check)                 // choose the restore source
 *     for (r of [...listBackups(file).reverse(), `${file}.ccr-original`])
 *       if (!exists(r)) continue
 *       if (!check(read(r))) return {content:read(r), file:r}   // first that passes
 *
 *   listBackups(file)                        // NOTE: exact `startsWith` prefix
 *     readdir(dir).filter(n => n.startsWith(basename + ".ccr-backup-")).sort()
 *
 *   isManagedContent(text, providerId)       // zcode's variant
 *     provider section contains providerId          → true
 *     model.main starts with "providerId/"          → true
 *     defaultModel / lastUsed / lastUsedModel .providerId === providerId → true
 *     providers[].id === providerId                 → true
 *     otherwise                                     → false
 *
 * TWO COUNTER-INTUITIVE CONSEQUENCES (both overturned an earlier assumption):
 *   1. ONLY `config.json.ccr-backup-*` participates. Hand-made backups like
 *      `config.json.bak-*` do NOT match `startsWith` and are never selected —
 *      so naming a backup `.ccr-backup-…` can accidentally make it the
 *      preferred restore source. (This was learned the hard way.)
 *   2. A snapshot must pass isManagedContent to be eligible at all. So
 *      "the hooks are broken" does NOT mean "there is a threat" — it must ALSO
 *      be managed. An unmanaged broken file is inert.
 *
 * Usage:
 *   node src/ccr-takeover-audit.mjs                          # audit discovered profiles
 *   node src/ccr-takeover-audit.mjs --json                   # machine-readable
 *   node src/ccr-takeover-audit.mjs --profile my=~/.foo.json:zcode
 *   node src/ccr-takeover-audit.mjs --expect-opencode-model <your-model-name>
 *
 * Exit code: 0 = no real threat; 1 = a bad snapshot would be picked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROVIDER_ID = "claude-code-router";
const REQUIRED_EVENTS = ["PreToolUse", "SessionStart", "PostToolUse", "Stop"];

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 从候选里取 CCR 会选中的那个：按名倒序（最新优先）取第一个 managed 的，
 * 全都不合格则回退 .ccr-original。对应源码的 J$e + X$e 组合。
 * 抽成纯函数是为了可单测——这条选择规则错了会静默选到坏快照。
 */
export function pickRestoreCandidate(items) {
  const backups = items
    .filter((i) => i.name.includes(".ccr-backup-"))
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const originals = items.filter((i) => i.name.endsWith(".ccr-original"));
  for (const c of [...backups, ...originals]) {
    if (c.managed) return c;
  }
  return null;
}

/** 真威胁 = 有资格被选中（managed）且 hooks 坏。managed=否 的坏文件是惰性的。 */
export function auditCandidates(items) {
  return items.filter((c) => c.managed && !c.hooksOk);
}

/** zcode's isManagedContent (the `ute` helper in ccr-cli.js). */
export function isManagedContent(text, id = PROVIDER_ID) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isObj(cfg)) return false;
  if (isObj(cfg.provider) && Object.prototype.hasOwnProperty.call(cfg.provider, id)) return true;
  if (isObj(cfg.model) && typeof cfg.model.main === "string" && cfg.model.main.startsWith(`${id}/`)) return true;
  for (const key of ["defaultModel", "lastUsed", "lastUsedModel"]) {
    const v = cfg[key];
    if (isObj(v) && v.providerId === id) return true;
  }
  if (Array.isArray(cfg.providers)) return cfg.providers.some((p) => isObj(p) && p.id === id);
  return false;
}

/** listBackups: exact `startsWith` prefix match, ascending. */
function listBackups(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.ccr-backup-`;
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Whether the hook set is complete and does not point at the retired ~/.claude/hooks dir. */
export function hooksHealth(text) {
  let events;
  try {
    events = (JSON.parse(text).hooks || {}).events || {};
  } catch {
    return { ok: false, events: [], reason: "unparseable" };
  }
  const missing = REQUIRED_EVENTS.filter((e) => !events[e]);
  // Matches both absolute (`C:/…/.claude/hooks/…`) and home-relative
  // (`~/.claude/hooks/…`) forms, on either separator.
  const stale = JSON.stringify(events).match(/(?:[A-Za-z]:[^"]*|~)[\\/][^"]*\.claude[\\/]hooks[^"]*/g) || [];
  if (missing.length) return { ok: false, events: Object.keys(events), reason: `missing ${missing.join(",")}` };
  if (stale.length) return { ok: false, events: Object.keys(events), reason: `points at retired ~/.claude/hooks: ${stale[0]}` };
  return { ok: true, events: Object.keys(events) };
}

/**
 * pickRestore: take the first existing candidate that passes the managed check,
 * walking in CCR's order. Returns {file, content} or null.
 */
function selectRestoreSource(file) {
  const candidates = [...listBackups(file).reverse(), `${file}.ccr-original`];
  for (const r of candidates) {
    if (!fs.existsSync(r)) continue;
    const content = fs.readFileSync(r, "utf8");
    if (!isManagedContent(content)) continue;
    return { file: r, content };
  }
  return null;
}

/**
 * opencode 的 isManagedContent 判据与 zcode 不同 —— 它查 provider 段里的
 * 客户端标识头，而不是 provider id：
 *   provider["claude-code-router"].options.headers["x-ccr-client"] === "opencode"
 *
 * 实测踩到过：手工把 model 改对后，CCR 用它自己的旧快照在两分钟内冲回旧值。
 * 这也是本工具存在的原因之一 —— 改 live 文件不够，要先看恢复源。
 */
export function isManagedOpencode(text, id = PROVIDER_ID) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isObj(cfg) || !isObj(cfg.provider)) return false;
  const n = cfg.provider[id];
  if (!isObj(n) || !isObj(n.options)) return false;
  const h = isObj(n.options.headers) ? n.options.headers : {};
  return h["x-ccr-client"] === "opencode" || h["X-CCR-Client"] === "opencode";
}

/**
 * opencode 的健康判据：model 是否**经由 CCR 且指向期望模型**。
 *
 * 期望模型由调用方传入（`expectedModel`，正则或字符串），不写死 —— 每个用户的
 * 主力模型不同，且会随上游改名而变化。不传则只检查「是否经由 CCR」。
 */
export function opencodeHealth(text, expectedModel = null) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return { ok: false, events: [], reason: "unparseable" };
  }
  const model = cfg.model || "";
  const small = cfg.small_model || "";
  const viaCcr = model.startsWith(`${PROVIDER_ID}/`);
  const matchesExpected = !expectedModel
    ? true
    : expectedModel instanceof RegExp
      ? expectedModel.test(model)
      : model.includes(expectedModel);
  const ok = viaCcr && matchesExpected && (!small || small === model);
  return {
    ok,
    events: [model || "(无 model)"],
    reason: ok
      ? ""
      : `${viaCcr ? "" : "未经 CCR；"}model=${model || "(无)"}${
          small && small !== model ? ` small_model=${small}` : ""
        }${!matchesExpected && expectedModel ? `（期望匹配 ${expectedModel}）` : ""}`,
  };
}

/**
 * 审计一个 CCR 接管的 profile。
 * managedOf / healthOf are supplied by the caller — zcode and opencode use
 * different predicates, but the "managed AND broken = real threat" rule is shared.
 */
function auditProfile({ file, managedOf, healthOf, label }) {
  const result = { label, file, exists: fs.existsSync(file) };
  if (!result.exists) return { ...result, status: "missing" };

  const live = fs.readFileSync(file, "utf8");
  result.managed = managedOf(live);
  result.liveHealth = healthOf(live);

  const candidates = [...listBackups(file).reverse(), `${file}.ccr-original`];
  result.candidates = candidates
    .filter((p) => fs.existsSync(p))
    .map((p) => {
      const text = fs.readFileSync(p, "utf8");
      const managed = managedOf(text);
      const h = healthOf(text);
      return {
        name: path.basename(p),
        managed,
        healthy: h.ok,
        reason: h.reason,
        threat: managed && !h.ok,
      };
    });

  result.threats = result.candidates.filter((c) => c.threat);

  // 恢复会选中哪个：倒序第一个 managed 的
  const picked = candidates.find((p) => fs.existsSync(p) && managedOf(fs.readFileSync(p, "utf8")));
  result.wouldPick = picked ? path.basename(picked) : null;
  result.pickIsHealthy = picked ? healthOf(fs.readFileSync(picked, "utf8")).ok : null;

  if (!result.managed) result.status = "inert";
  else if (result.threats.length) result.status = "threat";
  else if (result.pickIsHealthy === false) result.status = "pick-bad";
  else result.status = "ok";

  return result;
}

/**
 * 内置的已知 profile 位置（相对 home，跨平台）。
 * 找不到就跳过，不报错 —— 用户没装那个 agent 是正常情况。
 */
const KNOWN_PROFILES = [
  { label: "zcode", rel: [".zcode", "cli", "config.json"], kind: "zcode" },
  { label: "opencode", rel: [".config", "opencode", "opencode.jsonc"], kind: "opencode" },
  { label: "opencode (legacy)", rel: [".opencode", "config.json"], kind: "opencode" },
];

/**
 * 读取 CCR 自己的接管清单，据此决定审计哪些文件。
 *
 * CCR 把"我接管了哪些 profile"记在 `global-profile-takeover.json`。
 * 用它比硬编码路径可靠 —— 用户改过 profile 位置时也能跟上。
 * 读不到则回落到内置的已知位置。
 */
export function readTakeoverManifest(ccrHome) {
  const p = path.join(ccrHome, "global-profile-takeover.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(j.profiles) ? j.profiles : [];
  } catch {
    return null;
  }
}

/** 从接管清单条目推 profile 描述；识别不了 agent 类型的返回 null。 */
export function profileFromManifestEntry(entry) {
  const file = entry.configFile || entry.settingsFile;
  if (!file) return null;
  const resolved = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file;
  const agent = String(entry.agent || "").toLowerCase();
  if (agent === "zcode") return { label: `zcode (${entry.id || "?"})`, file: resolved, kind: "zcode" };
  if (agent === "opencode") return { label: `opencode (${entry.id || "?"})`, file: resolved, kind: "opencode" };
  // claude-code / codex 等走另一条恢复路径（settings.json 的 managed block），
  // 判据不同，不在本工具的覆盖范围内 —— 显式跳过而非误判。
  return null;
}

export function discoverProfiles(ccrHome, extra = []) {
  const fromManifest = (readTakeoverManifest(ccrHome) || [])
    .map(profileFromManifestEntry)
    .filter(Boolean);
  const known = KNOWN_PROFILES.map((k) => ({
    label: k.label,
    file: path.join(os.homedir(), ...k.rel),
    kind: k.kind,
  }));
  // 清单优先（它反映 CCR 的真实接管状态），再用已知位置补齐
  const seen = new Set();
  const out = [];
  for (const p of [...fromManifest, ...known, ...extra]) {
    const key = path.resolve(p.file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function auditAll(opts = {}) {
  const ccrHome = locateCcrHome();
  const profiles = discoverProfiles(ccrHome, opts.profiles || []);
  return profiles
    .map((p) =>
      auditProfile({
        label: p.label,
        file: p.file,
        managedOf: p.kind === "opencode" ? isManagedOpencode : (t) => isManagedContent(t),
        healthOf: p.kind === "opencode" ? (t) => opencodeHealth(t, opts.expectedOpencodeModel) : hooksHealth,
      }),
    )
    // 文件不存在的 profile 直接不列 —— 没装那个 agent 不是"缺失"，是正常
    .filter((r) => r.exists);
}

function locateCcrHome() {
  const candidates = [
    process.env.CCR_HOME,
    path.join(process.env.APPDATA || "", "claude-code-router"),
    path.join(os.homedir(), "AppData", "Roaming", "claude-code-router"),
    path.join(os.homedir(), "Library", "Application Support", "claude-code-router"),
    path.join(os.homedir(), ".claude-code-router"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
}

function parseArgs(argv) {
  const out = { json: false, profiles: [], expectedOpencodeModel: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--profile") {
      // format: <label>=<path>[:zcode|:opencode]
      const spec = argv[++i] || "";
      const eq = spec.indexOf("=");
      if (eq > 0) {
        const label = spec.slice(0, eq);
        let rest = spec.slice(eq + 1);
        let kind = "zcode";
        const ci = rest.lastIndexOf(":");
        if (ci > 1 && /^[a-z]+$/.test(rest.slice(ci + 1))) {
          kind = rest.slice(ci + 1);
          rest = rest.slice(0, ci);
        }
        out.profiles.push({ label, file: rest, kind });
      }
    } else if (a === "--expect-opencode-model") out.expectedOpencodeModel = argv[++i];
  }
  return out;
}

// Only run the CLI when invoked directly; importing (in tests) must not print or exit.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const r = auditAll(opts);

  if (opts.json) {
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.log("CCR takeover risk audit");
    if (r.length === 0) {
      console.log("\n  No CCR-managed profile found (or pass --profile <label>=<path>[:kind])");
    }
    let bad = 0;
    for (const p of r) {
      console.log("");
      console.log(`── ${p.label} ──`);
      console.log(`  file       : ${p.file}`);
      console.log(`  CCR manages: ${p.managed ? "yes (reads & writes this file)" : "no (inert)"}`);
      console.log(`  live health: ${p.liveHealth.ok ? "ok" : `BAD —— ${p.liveHealth.reason}`}`);
      console.log(`  candidates : ${p.candidates.length}`);
      console.log(`  REAL THREATS: ${p.threats.length}${p.threats.length ? "  ← a bad snapshot CCR would pick" : ""}`);
      for (const t of p.threats) console.log(`      !! ${t.name}  (${t.reason})`);
      console.log(`  would restore from: ${p.wouldPick ?? "(none passes the managed check)"}`);
      if (p.pickIsHealthy !== null) {
        console.log(`  picked is healthy : ${p.pickIsHealthy ? "yes" : "NO —— restoring it breaks the agent"}`);
      }
      console.log(
        p.status === "ok"
          ? "  OK: no threat"
          : p.status === "inert"
            ? "  OK: CCR does not manage this file"
            : p.status === "threat"
              ? "  THREAT: fix required"
              : "  THREAT: restore source would be picked but is unhealthy",
      );
      if (p.status === "threat" || p.status === "pick-bad") bad++;
    }
    process.exit(bad ? 1 : 0);
  }
}
