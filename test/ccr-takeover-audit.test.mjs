/**
 * ccr-takeover-audit 判据单测。
 *
 * 这些用例锁定的是从 CCR 源码逆向出的规则（ccr-cli.js 的 `ute` / `J$e` / `X$e`），
 * 每条都对应一次真实的误判教训：
 *   - 「hooks 坏」不等于「有威胁」——必须同时 managed，否则 CCR 根本不读
 *   - 只有 `config.json.ccr-backup-*` 参与选择，`.bak-*` 不匹配 startsWith
 *   - 恢复取「倒序第一个通过 isManagedContent 的」，不是「最新的」
 *
 * 判据若被改错，这些用例会红——这正是它们存在的意义。
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  isManagedContent,
  isManagedOpencode,
  hooksHealth,
  opencodeHealth,
  pickRestoreCandidate,
  auditCandidates,
  profileFromManifestEntry,
  discoverProfiles,
} from "../src/ccr-takeover-audit.mjs";

const ID = "claude-code-router";
const FULL_HOOKS = {
  events: {
    PreToolUse: [{ hooks: [{ command: "python", args: ["~/.zcode/hooks/block-dangerous.py"] }] }],
    SessionStart: [{ hooks: [{ command: "python", args: ["~/.zcode/hooks/session-charter.py"] }] }],
    PostToolUse: [{ hooks: [{ command: "python", args: ["~/.zcode/hooks/mark-edits.py"] }] }],
    Stop: [{ hooks: [{ command: "python", args: ["~/.zcode/hooks/stop-verify.py"] }] }],
  },
};
// A hook set that is broken by *missing events*, not by a stale path —
// keeps the two failure modes independently testable.
const BROKEN_HOOKS = {
  events: {
    PreToolUse: [{ hooks: [{ command: "python", args: ["~/.myagent/hooks/block-dangerous.py"] }] }],
  },
};
// 注意 provider 段的键必须是 CCR 的 providerId（claude-code-router），
// 不是上游名（alpha）——isManagedContent 查的正是这个键。
const cfg = (extra = {}) => JSON.stringify({ provider: { [ID]: {} }, hooks: FULL_HOOKS, ...extra });

describe("isManagedContent", () => {
  it("should accept a config whose provider section holds the CCR provider id", () => {
    expect(isManagedContent(cfg(), ID)).toBe(true);
  });

  it("should accept a config whose model.main is prefixed with the provider id", () => {
    const t = JSON.stringify({ model: { main: `${ID}/alpha/model-b-flash` } });
    expect(isManagedContent(t, ID)).toBe(true);
  });

  it("should accept a config carrying the provider id in defaultModel/lastUsed/lastUsedModel", () => {
    for (const key of ["defaultModel", "lastUsed", "lastUsedModel"]) {
      const t = JSON.stringify({ [key]: { providerId: ID } });
      expect(isManagedContent(t, ID)).toBe(true);
    }
  });

  it("should accept a config listing the provider id in a providers array", () => {
    expect(isManagedContent(JSON.stringify({ providers: [{ id: ID }] }), ID)).toBe(true);
  });

  it("should reject a config that only mentions an unrelated provider", () => {
    // 实测：4472B 那批快照只有 alpha，CCR 因此从不选它们
    const t = JSON.stringify({ provider: { alpha: {} }, model: "alpha/model-b" });
    expect(isManagedContent(t, ID)).toBe(false);
  });

  it("should reject unparseable text rather than throwing", () => {
    expect(isManagedContent("{not json", ID)).toBe(false);
  });
});

describe("isManagedOpencode", () => {
  // opencode 的判据与 zcode 不同：查 provider[ccr].options.headers["x-ccr-client"]
  const oc = (extra = {}) =>
    JSON.stringify({
      provider: { [ID]: { options: { headers: { "x-ccr-client": "opencode" } } } },
      ...extra,
    });

  it("should accept a config whose CCR provider carries the opencode client header", () => {
    expect(isManagedOpencode(oc())).toBe(true);
  });

  it("should reject a config whose CCR provider lacks the header", () => {
    const t = JSON.stringify({ provider: { [ID]: { options: { headers: {} } } } });
    expect(isManagedOpencode(t)).toBe(false);
  });

  it("should reject a config with no provider section", () => {
    expect(isManagedOpencode(JSON.stringify({ model: "x" }))).toBe(false);
  });

  it("should reject unparseable text", () => {
    expect(isManagedOpencode("{nope")).toBe(false);
  });
});

describe("opencodeHealth", () => {
  it("should accept a model routed through CCR when no expectation is given", () => {
    const t = JSON.stringify({
      model: "claude-code-router/some-provider/some-model",
      small_model: "claude-code-router/some-provider/some-model",
    });
    expect(opencodeHealth(t).ok).toBe(true);
  });

  it("should accept when the model matches the caller-supplied expectation", () => {
    const t = JSON.stringify({
      model: "claude-code-router/acme/model-z3x",
      small_model: "claude-code-router/acme/model-z3x",
    });
    expect(opencodeHealth(t, /model-z3x/).ok).toBe(true);
    expect(opencodeHealth(t, "model-z3x").ok).toBe(true);
  });

  it("should reject a model that does not match the expectation", () => {
    // The real failure: CCR restores an old snapshot with a retired pointer.
    const t = JSON.stringify({
      model: "claude-code-router/acme/retired-model",
      small_model: "claude-code-router/acme/retired-model",
    });
    expect(opencodeHealth(t, /model-z3x/).ok).toBe(false);
    expect(opencodeHealth(t, /model-z3x/).reason).toMatch(/retired-model/);
  });

  it("should reject a bare direct-connect model that bypasses CCR", () => {
    const t = JSON.stringify({ model: "acme/some-model" });
    expect(opencodeHealth(t).ok).toBe(false);
    expect(opencodeHealth(t).reason).toMatch(/未经 CCR|not via CCR/);
  });

  it("should reject when small_model disagrees with model", () => {
    const t = JSON.stringify({
      model: "claude-code-router/acme/model-z3x",
      small_model: "claude-code-router/acme/other-model",
    });
    expect(opencodeHealth(t).ok).toBe(false);
  });

  it("should tolerate an unparseable config", () => {
    expect(opencodeHealth("{ not json").ok).toBe(false);
  });
});

describe("hooksHealth", () => {
  it("should accept all four events pointing at ~/.zcode/hooks/", () => {
    expect(hooksHealth(cfg()).ok).toBe(true);
  });

  it("should reject a lone PreToolUse event", () => {
    const r = hooksHealth(JSON.stringify({ hooks: BROKEN_HOOKS }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SessionStart|PostToolUse|Stop/);
  });

  it("should reject a full event set that still points at the retired ~/.claude/hooks path", () => {
    // The nastiest case: every event is present, but the scripts were cleaned
    // out of ~/.claude → python exits 2 → the agent's shell dies entirely.
    const staleHook = [{ hooks: [{ command: "python", args: ["~/.claude/hooks/gone.py"] }] }];
    const allStale = { events: Object.fromEntries(Object.keys(FULL_HOOKS.events).map((k) => [k, staleHook])) };
    const r = hooksHealth(JSON.stringify({ hooks: allStale }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\.claude/);
  });

  it("should also detect an absolute Windows path to the retired hooks dir", () => {
    const staleHook = [{ hooks: [{ command: "python", args: ["C:/Users/someone/.claude/hooks/gone.py"] }] }];
    const allStale = { events: Object.fromEntries(Object.keys(FULL_HOOKS.events).map((k) => [k, staleHook])) };
    expect(hooksHealth(JSON.stringify({ hooks: allStale })).ok).toBe(false);
  });

  it("should not throw on malformed json", () => {
    expect(hooksHealth("{broken").ok).toBe(false);
  });
});

describe("pickRestoreCandidate", () => {
  it("should take the newest by name, since CCR reverses the sorted list", () => {
    // X$e 升序 → reverse → 第一个即名字最大的
    const items = [
      { name: "config.json.ccr-backup-2026-09-15T00-00-00-000Z", managed: true, ok: true },
      { name: "config.json.ccr-backup-2026-09-21T00-00-00-000Z", managed: true, ok: true },
    ];
    expect(pickRestoreCandidate(items).name).toContain("2026-09-21");
  });

  it("should skip a newer candidate that fails the managed check", () => {
    // 实测：4472B 快照名字更大但 managed=否，会被跳过
    const items = [
      { name: "config.json.ccr-backup-2026-09-21T00-00-00-000Z", managed: false, ok: true },
      { name: "config.json.ccr-backup-2026-09-20T00-00-00-000Z", managed: true, ok: true },
    ];
    expect(pickRestoreCandidate(items).name).toContain("2026-09-20");
  });

  it("should fall back to .ccr-original last, after every backup", () => {
    const items = [
      { name: "config.json.ccr-backup-2026-09-20T00-00-00-000Z", managed: false, ok: true },
      { name: "config.json.ccr-original", managed: true, ok: true },
    ];
    expect(pickRestoreCandidate(items).name).toBe("config.json.ccr-original");
  });

  it("should return null when nothing qualifies", () => {
    expect(pickRestoreCandidate([{ name: "x", managed: false, ok: true }])).toBe(null);
  });
});

describe("auditCandidates", () => {
  it("should flag only candidates that are both managed and broken", () => {
    // 核心判据：managed=否 的坏文件是惰性的，不该计入威胁
    const threats = auditCandidates([
      { name: "a", managed: true, hooksOk: false },
      { name: "b", managed: false, hooksOk: false },
      { name: "c", managed: true, hooksOk: true },
    ]);
    expect(threats.map((t) => t.name)).toEqual(["a"]);
  });

  it("should report no threats when every managed candidate is healthy", () => {
    expect(auditCandidates([{ name: "a", managed: true, hooksOk: true }])).toEqual([]);
  });
});

describe("profileFromManifestEntry", () => {
  it("should resolve a ~-prefixed zcode config path against the home dir", () => {
    const p = profileFromManifestEntry({ agent: "zcode", id: "zcode", configFile: "~/.zcode/cli/config.json" });
    expect(p.kind).toBe("zcode");
    expect(p.file).toBe(path.join(os.homedir(), ".zcode", "cli", "config.json"));
  });

  it("should resolve an opencode entry using settingsFile when configFile is absent", () => {
    const p = profileFromManifestEntry({ agent: "opencode", id: "opencode", settingsFile: "~/.config/opencode/opencode.jsonc" });
    expect(p.kind).toBe("opencode");
    expect(p.file).toContain("opencode.jsonc");
  });

  it("should return null for agents whose restore path this tool does not cover", () => {
    // claude-code / codex use a different restore mechanism (managed blocks in
    // settings.json / config.toml) with different rules — auditing them with
    // zcode's predicate would produce false verdicts.
    expect(profileFromManifestEntry({ agent: "claude-code", settingsFile: "~/.claude/settings.json" })).toBe(null);
    expect(profileFromManifestEntry({ agent: "codex", configFile: "~/.codex/config.toml" })).toBe(null);
  });

  it("should return null when the entry carries no file path", () => {
    expect(profileFromManifestEntry({ agent: "zcode", id: "z" })).toBe(null);
  });
});

describe("discoverProfiles", () => {
  it("should include the caller-supplied profiles", () => {
    const out = discoverProfiles("/nonexistent-ccr-home", [
      { label: "custom", file: "/tmp/custom.json", kind: "zcode" },
    ]);
    expect(out.some((p) => p.label === "custom")).toBe(true);
  });

  it("should de-duplicate paths that appear in several sources", () => {
    const dup = { label: "dup", file: path.join(os.homedir(), ".zcode", "cli", "config.json"), kind: "zcode" };
    const out = discoverProfiles("/nonexistent-ccr-home", [dup]);
    const hits = out.filter((p) => path.resolve(p.file).toLowerCase() === path.resolve(dup.file).toLowerCase());
    expect(hits.length).toBe(1);
  });

  it("should always include the built-in known locations as a fallback", () => {
    const out = discoverProfiles("/nonexistent-ccr-home");
    expect(out.some((p) => p.kind === "zcode")).toBe(true);
    expect(out.some((p) => p.kind === "opencode")).toBe(true);
  });
});
