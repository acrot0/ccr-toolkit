/**
 * Unit tests for cache-monitor's convention detection and grouping logic.
 *
 * Every case is shaped by real data from CCR's usage.sqlite:
 *   - the same model reports under different conventions per provider
 *     (model-z2 came back as remainder on one and total on another)
 *   - a retired provider path still sits inside the window and must not alarm
 * See the individual `it` blocks for the scenario behind each one.
 */
import { describe, it, expect } from "vitest";
import {
  inferConvention, resolveConvention, hitRateOf, shapeRow, windowToMs,
  normalizeModel, summarizeStatus, aggregateByLogicalModel, isFree,
} from "../src/cache-monitor.mjs";

// Build a sample row; the shape is {key, i, c}
const s = (key, i, c) => ({ key, i, c });

describe("inferConvention", () => {
  it("should classify as remainder when per-request input/cache ratio is tiny", () => {
    // alpha/model-b measured: input ~= the uncached remainder, ratio ~0.001
    const conv = inferConvention([s("alpha|model-b", 92, 5120), s("alpha|model-b", 120, 6000)]);
    expect(conv.get("alpha|model-b")).toBe("remainder");
  });

  it("should classify as total when per-request input/cache ratio is near or above 1", () => {
    // beta/model-z2 measured: input is the FULL prefix (hits included), ratio ~1.09
    const conv = inferConvention([s("beta|model-z2", 9000, 8000), s("beta|model-z2", 11000, 10000)]);
    expect(conv.get("beta|model-z2")).toBe("total");
  });

  it("should infer per provider, not per model, when the same model reports two conventions", () => {
    // Measured: model-z2 is remainder on the cred path and total on the beta preset
    const conv = inferConvention([
      s("beta|model-z2", 9000, 8000),
      s("beta::openai_chat_completions::cred:key-1-1|model-z2", 1000, 9000),
    ]);
    expect(conv.get("beta|model-z2")).toBe("total");
    expect(conv.get("beta::openai_chat_completions::cred:key-1-1|model-z2")).toBe("remainder");
  });
});

describe("resolveConvention", () => {
  it("should keep total when cached is not larger than uncached", () => {
    expect(resolveConvention("total", 10000, 8000)).toEqual({ convention: "total", corrected: false });
  });

  it("should fall back to remainder when total would yield more than 100 percent", () => {
    // Measured for model-g2 via chat_completions: c > i, so `total` would compute 137%
    expect(resolveConvention("total", 3067992, 4217856)).toEqual({ convention: "remainder", corrected: true });
  });

  it("should treat a model with zero cache reads as unsupported", () => {
    expect(resolveConvention("remainder", 32317057, 0)).toEqual({ convention: "remainder", corrected: false });
  });
});

describe("hitRateOf", () => {
  it("should compute remainder hit rate as cached over full prefix", () => {
    expect(hitRateOf("remainder", 92, 5120)).toBeCloseTo(98.24, 1);
  });

  it("should compute total hit rate as cached over input", () => {
    expect(hitRateOf("total", 10000, 8000)).toBe(80);
  });

  it("should never report a hit rate above 100 percent", () => {
    expect(hitRateOf("remainder", 3067992, 4217856)).toBeLessThanOrEqual(100);
    expect(hitRateOf("total", 3067992, 4217856)).toBeLessThanOrEqual(100);
  });
});

describe("shapeRow", () => {
  const now = Date.parse("2026-09-13T16:00:00.000Z");
  const liveHours = 24;

  it("should mark a path seen within the live window as live", () => {
    const row = shapeRow(
      { key: "gamma::openai_chat_completions::cred:key-1-1|model-g2", requests: 12, uncached: 91692, cached: 164608, lastSeen: "2026-09-13T15:00:00.000Z" },
      new Map(), liveHours, now
    );
    expect(row.live).toBe(true);
  });

  it("should mark a retired path as not live so it cannot trip the gate", () => {
    // Measured: gamma's 0% anthropic path last appeared 2026-09-09; by 09-10 it had moved to chat_completions
    const row = shapeRow(
      { key: "gamma|model-g/model-g2", requests: 82, uncached: 1587701, cached: 0, lastSeen: "2026-09-09T20:25:49.315Z" },
      new Map(), liveHours, now
    );
    expect(row.live).toBe(false);
    expect(row.unsupported).toBe(true);
  });

  it("should fall back to remainder and flag correction when the inferred convention is impossible", () => {
    const row = shapeRow(
      { key: "prov|m", requests: 10, uncached: 100, cached: 300, lastSeen: "2026-09-13T15:00:00.000Z" },
      new Map([["prov|m", "total"]]), liveHours, now
    );
    expect(row.convention).toBe("remainder");
    expect(row.corrected).toBe(true);
    expect(row.hitRate).toBeCloseTo(75, 5);
  });

  it("should keep provider and model separate in the row for display", () => {
    const row = shapeRow(
      { key: "alpha::anthropic_messages|model-b-flash", requests: 5, uncached: 100, cached: 900, lastSeen: "2026-09-13T15:00:00.000Z" },
      new Map(), liveHours, now
    );
    expect(row.provider).toBe("alpha::anthropic_messages");
    expect(row.model).toBe("model-b-flash");
  });
});

describe("windowToMs", () => {
  it("should parse minute, hour and day windows", () => {
    expect(windowToMs("60m")).toBe(3600000);
    expect(windowToMs("24h")).toBe(86400000);
    expect(windowToMs("7d")).toBe(604800000);
  });

  it("should reject a malformed window instead of silently defaulting", () => {
    expect(() => windowToMs("24")).toThrow();
  });
});

/**
 * Why normalize: CCR's usage_events recorded one model under 5 spellings,
 * splitting its cumulative cost across $38.12 / $1.51 / $0.01 / $0 — summing by
 * raw string necessarily under-reports. The 5 strings below are copied from the
 * live database.
 */
describe("normalizeModel", () => {
  const aliases = new Map([["model-b-flash", "model-b"]]);

  it("should collapse all five real spellings of one model into one logical name", () => {
    const real = [
      "alpha/model-b-0731",
      "model-b-flash",
      "model-b-0731",
      "alpha/model-b-1-expires-on-0910",
      "beta/model-z2",
    ];
    const got = real.map((m) => normalizeModel(m, aliases));
    expect(got.slice(0, 4)).toEqual([
      "model-b",
      "model-b",
      "model-b",
      "model-b-1",
    ]);
    expect(got[4]).toBe("model-z2");
  });

  it("should strip the provider prefix before the last slash", () => {
    expect(normalizeModel("gamma::openai_chat_completions::cred:key-1-1/model-g2", aliases)).toBe("model-g2");
  });

  it("should strip an expiry note rather than treating it as part of the name", () => {
    expect(normalizeModel("model-b-1-expires-on-0910", aliases)).toBe("model-b-1");
  });

  it("should strip a trailing build date so versioned and unversioned names merge", () => {
    expect(normalizeModel("model-b-0731", aliases)).toBe("model-b");
  });

  it("should leave a model without a trailing date untouched", () => {
    expect(normalizeModel("step-3.7-flash", aliases)).toBe("step-3.7-flash");
    expect(normalizeModel("model-z3-flash", aliases)).toBe("model-z3-flash");
  });

  it("should prefer an explicit alias over the generic rules", () => {
    expect(normalizeModel("model-b-flash", new Map([["model-b-flash", "custom-name"]]))).toBe("custom-name");
  });

  it("should fall back to the trimmed raw name when given junk", () => {
    expect(normalizeModel("", aliases)).toBe("");
    expect(normalizeModel(undefined, aliases)).toBe("");
  });
});

/**
 * Why: usage_events held 420 rows with status_code=0 (over two days only), all
 * carrying normal output_tokens — a logging gap where the request succeeded but
 * the status was never recorded. Counting them as failures understates a ~90%
 * success rate as 66.7%.
 */
describe("summarizeStatus", () => {
  const rows = [
    { status_code: 200, n: 1210 },
    { status_code: 0, n: 420 },
    { status_code: 429, n: 171 },
    { status_code: 502, n: 6 },
  ];

  it("should exclude the logging gap from the failure count", () => {
    const s = summarizeStatus(rows);
    expect(s.loggingGap).toBe(420);
    expect(s.failed).toBe(177); // 429 + 502, excluding status=0
  });

  it("should compute success rate against real attempts, not the raw total", () => {
    const s = summarizeStatus(rows);
    // 1210 / (1210 + 171 + 6); status=0 is excluded from the denominator
    expect(s.successRate).toBeCloseTo(87.2, 1);
  });

  it("should label every status it reports", () => {
    const s = summarizeStatus(rows);
    const labels = Object.fromEntries(s.byStatus.map((r) => [r.status, r.label]));
    expect(labels[0]).toMatch(/logging gap/);
    expect(labels[429]).toMatch(/rate limited/);
    expect(labels[200]).toMatch(/success/);
  });

  it("should surface the top failure reason instead of only a count", () => {
    expect(summarizeStatus(rows).topFailure).toMatch(/429/);
  });

  it("should label the failure count as raw log entries, since bursts inflate it", () => {
    // Measured: 494 rate-limit rows collapse into 53 events — unlabelled, it reads as 494 real failures
    const s = summarizeStatus(rows);
    expect(s.topFailure).toMatch(/log rows/);
    expect(s.topFailure).toMatch(/ccr-check/);
  });

  it("should report a clean bill when everything succeeded", () => {
    const s = summarizeStatus([{ status_code: 200, n: 10 }]);
    expect(s.failed).toBe(0);
    expect(s.successRate).toBe(100);
    expect(s.topFailure).toBeNull();
  });
});

/**
 * Why: CCR's cost_usd is ESTIMATED from a pricing table (cost_source =
 * 'models.dev' / 'litellm'), not read from a bill. Measured: gamma showed $0
 * throughout (empty cost_source) while beta/model-z2 was costed at $10.45 by the
 * litellm table — yet both providers are in fact free. Without declaring that,
 * the report treats free quota as money actually spent (this once made model-z2
 * look like the most expensive model in the fleet).
 */
describe("isFree", () => {
  const cfg = { freeProviders: ["gamma", "beta"], freeModels: ["model-z2"] };

  it("should treat a declared-free provider as free whatever the model is", () => {
    expect(isFree("gamma", "anything", cfg)).toBe(true);
    expect(isFree("beta", "model-z4", cfg)).toBe(true);
  });

  it("should match the provider prefix including credential suffixes", () => {
    // Measured runtime provider name looks like gamma::openai_chat_completions::cred:key-1-1
    expect(isFree("gamma::openai_chat_completions::cred:key-1-1", "model-g2", cfg)).toBe(true);
    expect(isFree("beta::openai_chat_completions::cred:key-1-1", "model-z2", cfg)).toBe(true);
  });

  it("should treat a declared-free model as free even on an otherwise paid provider", () => {
    expect(isFree("some-paid-provider", "model-z2", cfg)).toBe(true);
  });

  it("should not mark a paid provider as free", () => {
    expect(isFree("alpha::anthropic_messages", "model-b-flash", cfg)).toBe(false);
    expect(isFree("stepfun", "step-3.7-flash", cfg)).toBe(false);
  });

  it("should treat an unknown provider with no free marker as paid", () => {
    expect(isFree("unknown", "some-model", cfg)).toBe(false);
    expect(isFree("", "", cfg)).toBe(false);
  });

  it("should not crash on a missing config", () => {
    expect(isFree("gamma", "m", undefined)).toBe(false);
  });
});

describe("aggregateByLogicalModel", () => {
  it("should sum cost and tokens of one model across its provider spellings", () => {
    const rows = [
      { model: "alpha/model-b-0731", provider: "alpha", requests: 3847, uncached: 100, cached: 900, cost: 38.12 },
      { model: "model-b-flash", provider: "alpha::anthropic_messages", requests: 1564, uncached: 50, cached: 450, cost: 1.51 },
    ];
    const out = aggregateByLogicalModel(rows, new Map([["model-b-flash", "model-b"]]));
    expect(out).toHaveLength(1);
    expect(out[0].logical).toBe("model-b");
    expect(out[0].requests).toBe(5411);
    expect(out[0].cost).toBeCloseTo(39.63, 2);
    expect(out[0].spellings).toHaveLength(2);
  });

  it("should keep models that normalize differently as separate entries", () => {
    const rows = [
      { model: "model-z2", provider: "beta", requests: 1, uncached: 1, cached: 1, cost: 0.1 },
      { model: "step-3.7-flash", provider: "stepfun", requests: 1, uncached: 1, cached: 1, cost: 0.2 },
    ];
    expect(aggregateByLogicalModel(rows, new Map())).toHaveLength(2);
  });

  it("should recompute the hit rate on the merged totals, not average the rates", () => {
    // One row at 100% and one at 0%; merged this must be 50%, not (100+0)/2
    const rows = [
      { model: "a-0731", provider: "p1", requests: 1, uncached: 0, cached: 100, cost: 0 },
      { model: "a", provider: "p2", requests: 1, uncached: 100, cached: 0, cost: 0 },
    ];
    const out = aggregateByLogicalModel(rows, new Map([["a", "a"]]));
    expect(out[0].uncached).toBe(100);
    expect(out[0].cached).toBe(100);
    expect(out[0].hitRate).toBeCloseTo(50, 5);
  });

  it("should mark a free provider and keep its estimate out of billable spend", () => {
    const rows = [
      { model: "beta/model-z2", provider: "beta", requests: 69, uncached: 10, cached: 90, cost: 10.45 },
      { model: "alpha/model-b-0731", provider: "alpha", requests: 100, uncached: 10, cached: 990, cost: 38.0 },
    ];
    const cfg = { freeProviders: ["beta"], freeModels: [] };
    const out = aggregateByLogicalModel(rows, new Map(), cfg);
    const free = out.find((a) => a.logical === "model-z2");
    const paid = out.find((a) => a.logical === "model-b");
    expect(free.free).toBe(true);
    expect(free.estimatedCost).toBeCloseTo(10.45, 2);
    expect(free.cost).toBe(0); // free paths stay out of the billable total
    expect(paid.free).toBe(false);
    expect(paid.cost).toBeCloseTo(38.0, 2);
  });

  it("should still count a free model's requests and tokens, only its cost is zeroed", () => {
    const rows = [{ model: "model-z2", provider: "beta", requests: 104, uncached: 100, cached: 100, cost: 10.73 }];
    const out = aggregateByLogicalModel(rows, new Map(), { freeProviders: ["beta"], freeModels: [] });
    expect(out[0].requests).toBe(104);
    expect(out[0].hitRate).toBeCloseTo(50, 5);
    expect(out[0].estimatedCost).toBeCloseTo(10.73, 2);
  });
});
