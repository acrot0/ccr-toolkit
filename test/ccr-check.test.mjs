/**
 * Unit tests for ccr-check.
 *
 * The assertions come from a real forensic pass over CCR 3.1.0 config and three
 * sqlite files: every fixture number (fallback off, a 598MB file with 13.5MB
 * live, elision marker at offset 80033, 420 rows with status=0) was copied out
 * of live local data — none of it is invented.
 */
import { describe, it, expect } from "vitest";
import {
  hasPreviewMarker, previewOmittedBytes, PREVIEW_MARKER,
  checkFallback, checkProfile, checkBloat, checkPreviewLoss, checkLoggingGap,
  overallLevel, exitCodeFor, clusterTimestamps, checkRateLimitBursts,
  notInstalled,
  exitCodeFor,
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
    expect(c.detail).toMatch(/cache/i);
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
    // Measured: both slots point at gamma/model-g2, so background verification loses independence
    const c = checkProfile(good);
    expect(c.detail).toMatch(/sonnet/);
  });

  it("should warn when a slot points at a model whose name announces its own expiry", () => {
    const c = checkProfile({ ...good, opusModel: "alpha/model-b-1-expires-on-0910" });
    expect(c.level).toBe("warn");
    expect(c.detail).toMatch(/expires/i);
  });
});

describe("checkBloat", () => {
  it("should flag a file that is mostly free pages", () => {
    // Measured on request-logs.sqlite: 598.1MB file / 13.5MB live
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
    // Measured: 99 of 112 contained the elision marker
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
 * Motivation: measured 494 rate-limit rows collapsing into only 53 distinct
 * events, the largest cluster holding 38 rows at 0-1s gaps — that is a parallel
 * fan-out burst, not 494 independent failures. Reporting raw rows inflates the
 * problem roughly tenfold.
 *
 * The intra-cluster gap also separates the two causes: one-second gaps = the
 * client blew the RPM limit in parallel; even gaps = sequential retry.
 */
describe("clusterTimestamps / checkRateLimitBursts", () => {
  const at = (hhmmss) => `2026-09-11T${hhmmss}.000Z`;

  it("should collapse a parallel burst into one event", () => {
    // 0-1s gaps = a parallel burst
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
    // 30s gaps = sequential retry with backoff, not concurrency
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
    expect(c.detail).toMatch(/fan-out|burst/i);
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

describe("notInstalled", () => {
  // Regression guard. Reporting "CCR is not installed" as a `fail` made the
  // tool exit 1 on any machine without CCR — which is exactly where the CI
  // smoke test runs, so the tool was unusable precisely where it was needed.
  it("should report a warning, not a failure", () => {
    const r = notInstalled();
    expect(r.checks[0].level).toBe("warn");
    expect(r.checks[0].level).not.toBe("fail");
  });

  it("should mark the installation as absent so callers can branch on it", () => {
    expect(notInstalled().facts.ccrInstalled).toBe(false);
  });

  it("should exit 0 — nothing is wrong with a machine that has no CCR", () => {
    expect(exitCodeFor(notInstalled().checks)).toBe(0);
  });
});
