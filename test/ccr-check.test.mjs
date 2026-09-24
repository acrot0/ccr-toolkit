/**
 * ccr-check 的单测。
 *
 * 断言来自 2026-09-13 对 CCR 3.1.0 配置与三个 sqlite 的真实取证：
 * 所有 fixture 数值（fallback off、598MB 文件 13.5MB 有效、省略标记位置 80033、
 * status=0 的 420 条）都是从本机数据抄下来的，不是构造的假数。
 */
import { describe, it, expect } from "vitest";
import {
  hasPreviewMarker, previewOmittedBytes, PREVIEW_MARKER,
  checkFallback, checkProfile, checkBloat, checkPreviewLoss, checkLoggingGap,
  overallLevel, exitCodeFor, clusterTimestamps, checkRateLimitBursts,
} from "../src/ccr-check.mjs";

describe("preview marker", () => {
  it("should detect CCR's mid-body omission marker", () => {
    const body = '{"a":1,"b":"... 511342 bytes omitted from preview ...","c":2}';
    expect(hasPreviewMarker(body)).toBe(true);
    expect(previewOmittedBytes(body)).toBe(511342);
  });

  it("should report no marker for an intact body", () => {
    expect(hasPreviewMarker('{"tools":[]}')).toBe(false);
    expect(previewOmittedBytes('{"tools":[]}')).toBeNull();
  });

  it("should sum several markers when a body was split more than once", () => {
    const body = "x... 100 bytes omitted from preview ...y... 250 bytes omitted from preview ...z";
    expect(previewOmittedBytes(body)).toBe(350);
  });

  it("should not be fooled by the phrase appearing without a byte count", () => {
    expect(hasPreviewMarker("bytes omitted from preview")).toBe(false);
  });
});

describe("checkFallback", () => {
  it("should fail when fallback is off, because 429 then returns straight to the client", () => {
    const c = checkFallback({ mode: "off", models: [], retryCount: 1 });
    expect(c.level).toBe("fail");
    expect(c.detail).toMatch(/429/);
  });

  it("should pass once fallback is retry mode", () => {
    expect(checkFallback({ mode: "retry", retryCount: 3 }).level).toBe("ok");
  });

  it("should pass for model-chain but warn about cache identity", () => {
    const c = checkFallback({ mode: "model-chain", models: ["a/b"], retryCount: 3 });
    expect(c.level).toBe("warn");
    expect(c.detail).toMatch(/缓存|cache/i);
  });

  it("should warn when the config is missing entirely", () => {
    expect(checkFallback(undefined).level).toBe("warn");
  });
});

describe("checkProfile", () => {
  const good = {
    model: "gamma/model-g2",
    opusModel: "alpha/model-b-flash[1m]",
    sonnetModel: "gamma/model-g2",
    haikuModel: "beta/model-z2[1m]",
    fableModel: "stepfun/step-3.7-flash",
  };

  it("should pass a profile with all five slots filled", () => {
    expect(checkProfile(good).level).toBe("ok");
  });

  it("should fail when a slot is empty, since that alias silently has no model", () => {
    const c = checkProfile({ ...good, fableModel: "" });
    expect(c.level).toBe("fail");
    expect(c.detail).toMatch(/fable/);
  });

  it("should note when main and sonnet point at the same model", () => {
    // 实测：两个槽都是 gamma/model-g2，后台验证失去了独立性
    const c = checkProfile(good);
    expect(c.detail).toMatch(/sonnet/);
  });

  it("should warn when a slot points at a model whose name announces its own expiry", () => {
    const c = checkProfile({ ...good, opusModel: "alpha/model-b-1-expires-on-0910" });
    expect(c.level).toBe("warn");
    expect(c.detail).toMatch(/过期|expires/);
  });
});

describe("checkBloat", () => {
  it("should flag a file that is mostly free pages", () => {
    // 实测 request-logs.sqlite：598.1MB 文件 / 13.5MB 有效
    const c = checkBloat({ label: "request-logs", fileBytes: 598.1 * 1048576, liveBytes: 13.5 * 1048576 });
    expect(c.level).toBe("warn");
    expect(c.detail).toMatch(/VACUUM/);
  });

  it("should pass a compact database", () => {
    expect(checkBloat({ label: "usage", fileBytes: 5.5 * 1048576, liveBytes: 5.5 * 1048576 }).level).toBe("ok");
  });

  it("should not divide by zero on an empty file", () => {
    expect(checkBloat({ label: "x", fileBytes: 0, liveBytes: 0 }).level).toBe("ok");
  });
});

describe("checkPreviewLoss", () => {
  it("should flag when most bodies are stored only as a preview", () => {
    // 实测 99/112 含省略标记
    const texts = Array.from({ length: 112 }, (_, i) =>
      i < 99 ? 'x"... 511342 bytes omitted from preview ..."y' : '{"ok":1}');
    const c = checkPreviewLoss(texts);
    expect(c.level).toBe("warn");
    expect(c.detail).toMatch(/88%/);
  });

  it("should pass when bodies are stored intact", () => {
    expect(checkPreviewLoss(['{"a":1}', '{"b":2}']).level).toBe("ok");
  });

  it("should not crash on an empty sample", () => {
    expect(checkPreviewLoss([]).level).toBe("ok");
  });
});

describe("checkLoggingGap", () => {
  it("should warn when status=0 rows exist, because they distort the success rate", () => {
    const c = checkLoggingGap([{ status_code: 200, n: 2427 }, { status_code: 0, n: 420 }]);
    expect(c.level).toBe("warn");
    expect(c.detail).toMatch(/420/);
  });

  it("should pass when no gap rows exist", () => {
    expect(checkLoggingGap([{ status_code: 200, n: 10 }]).level).toBe("ok");
  });
});

/**
 * 动因：2026-09-13 实测 494 条 429 只聚成 53 个独立事件，最大簇内 38 条且
 * 间隔 0~1 秒 —— 是并行 fan-out 爆发，不是 494 次独立失败。
 * 直接报原始条数会把问题夸大近 10 倍（我据此写过"429 ×171"的结论）。
 * 簇内间隔还能区分两种成因：秒级并发 = 客户端并行打爆 RPM；均匀间隔 = 顺序重试。
 */
describe("clusterTimestamps / checkRateLimitBursts", () => {
  const at = (hhmmss) => `2026-09-11T${hhmmss}.000Z`;

  it("should collapse a parallel burst into one event", () => {
    // 间隔 0~1 秒 = 并行爆发
    const ts = ["05:11:17", "05:11:17", "05:11:18", "05:11:18", "05:11:19"].map(at);
    const c = clusterTimestamps(ts, 10);
    expect(c.events).toHaveLength(1);
    expect(c.events[0].count).toBe(5);
  });

  it("should separate events that are far apart in time", () => {
    const ts = ["05:11:17", "05:11:18", "19:28:53", "19:28:54"].map(at);
    expect(clusterTimestamps(ts, 10).events).toHaveLength(2);
  });

  it("should label a burst whose gaps are sub-second as parallel", () => {
    const ts = ["05:11:17", "05:11:17", "05:11:17", "05:11:18"].map(at);
    expect(clusterTimestamps(ts, 10).events[0].pattern).toBe("parallel");
  });

  it("should label evenly spaced retries as sequential", () => {
    // 30 秒间隔 = 顺序退避重试，不是并发
    const ts = ["05:00:00", "05:00:30", "05:01:00", "05:01:30"].map(at);
    const c = clusterTimestamps(ts, 60);
    expect(c.events[0].pattern).toBe("sequential");
  });

  it("should report the raw count alongside the event count", () => {
    const ts = ["05:11:17", "05:11:17", "05:11:18", "19:28:53"].map(at);
    const c = clusterTimestamps(ts, 10);
    expect(c.total).toBe(4);
    expect(c.events).toHaveLength(2);
  });

  it("should not divide by zero on a single timestamp or none", () => {
    expect(clusterTimestamps([at("05:00:00")], 10).events[0].pattern).toBe("isolated");
    expect(clusterTimestamps([], 10)).toEqual({ total: 0, events: [] });
  });

  it("should warn when bursts dominate, and name the likely cause", () => {
    const ts = Array.from({ length: 40 }, () => at("05:11:17"));
    const c = checkRateLimitBursts(ts);
    expect(c.level).toBe("warn");
    expect(c.detail).toMatch(/并行|fan-out|并发/);
  });

  it("should pass when there are no rate-limit events", () => {
    expect(checkRateLimitBursts([]).level).toBe("ok");
  });

  it("should pass when rate limits are isolated rather than bursty", () => {
    const ts = ["2026-09-11T01:00:00.000Z", "2026-09-11T05:00:00.000Z", "2026-09-11T09:00:00.000Z"];
    expect(checkRateLimitBursts(ts).level).toBe("ok");
  });
});

describe("overallLevel / exitCodeFor", () => {
  it("should rank fail above warn above ok", () => {
    expect(overallLevel([{ level: "ok" }, { level: "warn" }])).toBe("warn");
    expect(overallLevel([{ level: "warn" }, { level: "fail" }])).toBe("fail");
    expect(overallLevel([{ level: "ok" }])).toBe("ok");
    expect(overallLevel([])).toBe("ok");
  });

  it("should exit 1 only on fail, so warnings do not break automation", () => {
    expect(exitCodeFor([{ level: "warn" }])).toBe(0);
    expect(exitCodeFor([{ level: "fail" }])).toBe(1);
    expect(exitCodeFor([{ level: "ok" }])).toBe(0);
  });
});
