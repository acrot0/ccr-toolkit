import { describe, it, expect } from 'vitest';
import { parseTrace, timeline, failureHop, modelJourney, retryLadder, outcomeReason, renderTimeline } from '../src/trace-view.mjs';

/**
 * Fixtures are trimmed from traces captured on a real local CCR install —
 * one clean success, one 400, and one 429 that retried four times.
 */
const HOP = (seq, phase, name, status, ms, extra = {}) => ({
  seq, phase, name, status, durationMs: ms, changes: [], ...extra,
});

const SUCCESS = JSON.stringify({
  version: 2, complete: true, hopCount: 7, attemptCount: 1,
  hops: [
    HOP(0, 'ingress', 'request.ingress', 'ok', 0),
    HOP(1, 'ingress', 'gateway.header-normalization', 'ok', 0),
    HOP(2, 'routing', 'router.route-output', 'ok', 0),
    HOP(3, 'planning', 'fallback.execution-plan', 'noop', 0),
    HOP(4, 'capability', 'provider.capability-routing', 'ok', 0),
    HOP(5, 'attempt', 'upstream.attempt.prepare', 'ok', 6),
    HOP(6, 'outcome', 'upstream.attempt.outcome', 'ok', 1770, { outcome: { statusCode: 200 } }),
  ],
});

const FAILED_400 = JSON.stringify({
  version: 2, complete: true, hopCount: 7, attemptCount: 1,
  hops: [
    HOP(0, 'ingress', 'request.ingress', 'ok', 0),
    HOP(5, 'attempt', 'upstream.attempt.prepare', 'ok', 1),
    HOP(6, 'outcome', 'upstream.attempt.outcome', 'error', 796, { outcome: { statusCode: 400 } }),
  ],
});

const RETRIED_429 = JSON.stringify({
  version: 2, complete: true, hopCount: 16, attemptCount: 4,
  hops: [
    HOP(5, 'attempt', 'upstream.attempt.prepare', 'ok', 13),
    HOP(6, 'outcome', 'upstream.attempt.outcome', 'error', 448, {
      outcome: { fallbackReason: 'http:429', retryDelayMs: 1000, statusCode: 429 },
    }),
    HOP(7, 'capability', 'provider.capability-routing', 'ok', 0),
    HOP(8, 'attempt', 'upstream.attempt.prepare', 'ok', 13),
    HOP(9, 'outcome', 'upstream.attempt.outcome', 'error', 213, {
      outcome: { fallbackReason: 'http:429', retryDelayMs: 2000, statusCode: 429 },
    }),
    HOP(10, 'capability', 'provider.capability-routing', 'ok', 0),
    HOP(11, 'attempt', 'upstream.attempt.prepare', 'ok', 27),
    HOP(12, 'outcome', 'upstream.attempt.outcome', 'error', 212, {
      outcome: { fallbackReason: 'http:429', retryDelayMs: 4000, statusCode: 429 },
    }),
  ],
});

describe('parseTrace', () => {
  it('should parse a valid trace and expose its hops', () => {
    const t = parseTrace(SUCCESS);
    expect(t.hops).toHaveLength(7);
    expect(t.complete).toBe(true);
  });

  it('should return null rather than throwing on malformed JSON', () => {
    expect(parseTrace('{not json')).toBeNull();
    expect(parseTrace(null)).toBeNull();
    expect(parseTrace('')).toBeNull();
  });

  it('should return null when the payload has no hops array', () => {
    expect(parseTrace(JSON.stringify({ version: 2 }))).toBeNull();
  });
});

describe('timeline', () => {
  it('should keep hop order and carry the fields a reader needs', () => {
    const t = timeline(parseTrace(SUCCESS).hops);
    expect(t.map((h) => h.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(t[6]).toMatchObject({ name: 'upstream.attempt.outcome', status: 'ok', ms: 1770 });
  });

  it('should summarize each hop\'s changes as operation:path', () => {
    const hops = [{ seq: 1, phase: 'ingress', name: 'x', status: 'ok', durationMs: 0,
      changes: [{ operation: 'remove', path: '/headers/x-api-key' }, { operation: 'add', path: '/headers/x-auth-sub' }] }];
    expect(timeline(hops)[0].changes).toEqual(['remove:/headers/x-api-key', 'add:/headers/x-auth-sub']);
  });

  it('should handle a hop with no changes field', () => {
    expect(timeline([{ seq: 0, phase: 'ingress', name: 'x', status: 'ok', durationMs: 0 }])[0].changes).toEqual([]);
  });

  it('should return an empty array for empty input', () => {
    expect(timeline([])).toEqual([]);
    expect(timeline(null)).toEqual([]);
  });
});

describe('failureHop', () => {
  it('should find the hop where the upstream call actually failed', () => {
    const f = failureHop(parseTrace(FAILED_400).hops);
    expect(f).toMatchObject({ seq: 6, name: 'upstream.attempt.outcome', status: 'error' });
    expect(f.statusCode).toBe(400);
  });

  it('should return the LAST failure, since earlier ones are retries that were superseded', () => {
    const f = failureHop(parseTrace(RETRIED_429).hops);
    expect(f.statusCode).toBe(429);
    expect(f.seq).toBe(12);
  });

  it('should return null when nothing failed', () => {
    expect(failureHop(parseTrace(SUCCESS).hops)).toBeNull();
  });

  it('should not treat a noop hop as a failure', () => {
    expect(failureHop([HOP(3, 'planning', 'fallback.execution-plan', 'noop', 0)])).toBeNull();
  });
});

describe('modelJourney', () => {
  it('should track the model name across every rewrite hop', () => {
    const hops = [
      { seq: 4, changes: [{ operation: 'replace', path: '/body/model', before: 'tokenrhythm7/deepseek-flash', after: 'tokenrhythm::anthropic_messages/deepseek-flash' }] },
      { seq: 5, changes: [{ operation: 'replace', path: '/body/model', before: 'tokenrhythm7/deepseek-flash', after: 'tokenrhythm::anthropic_messages/deepseek-flash' }] },
    ];
    const j = modelJourney(hops);
    expect(j).toHaveLength(2);
    expect(j[0]).toMatchObject({ seq: 4, from: 'tokenrhythm7/deepseek-flash', to: 'tokenrhythm::anthropic_messages/deepseek-flash' });
  });

  it('should skip the hop that sets the model for the first time', () => {
    // Measured on every real trace: hop 2 replaces /body with the client's
    // model, so `before` is absent. That is the client's own name arriving,
    // not a rewrite — reporting "null → X" as a rewrite is noise.
    const hops = [{ seq: 2, changes: [{ operation: 'replace', path: '/body', after: 'tokenrhythm7/deepseek-flash' }] }];
    expect(modelJourney(hops)).toEqual([]);
  });

  it('should ignore changes to paths other than the model', () => {
    const hops = [{ seq: 1, changes: [{ operation: 'remove', path: '/headers/authorization' }] }];
    expect(modelJourney(hops)).toEqual([]);
  });

  it('should return an empty array when there are no model rewrites', () => {
    expect(modelJourney(parseTrace(SUCCESS).hops)).toEqual([]);
  });
});

describe('retryLadder', () => {
  it('should surface the backoff sequence so a rate-limit failure is legible', () => {
    const r = retryLadder(parseTrace(RETRIED_429).hops);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.delayMs)).toEqual([1000, 2000, 4000]);
    expect(r.every((x) => x.statusCode === 429)).toBe(true);
  });

  it('should NOT call a zero-delay network error a retry', () => {
    // Measured on a real 499: {fallbackReason: "network-error", retryDelayMs: 0}.
    // The field is present but nothing was actually retried — reporting
    // "retried with backoff 0ms" is a fabrication.
    const hops = [{ seq: 6, status: 'error', outcome: { fallbackReason: 'network-error', retryDelayMs: 0 } }];
    expect(retryLadder(hops)).toEqual([]);
  });

  it('should be empty when the request never retried', () => {
    expect(retryLadder(parseTrace(SUCCESS).hops)).toEqual([]);
    expect(retryLadder(parseTrace(FAILED_400).hops)).toEqual([]);
  });
});

describe('outcomeReason', () => {
  it('should surface why the gateway gave up when it was not an HTTP status', () => {
    // A 499 has no upstream status code at all — the reason field is the only
    // thing that explains it.
    const hops = [{ seq: 6, status: 'error', outcome: { error: 'Client connection closed before response completed.', fallbackReason: 'network-error', retryDelayMs: 0 } }];
    expect(outcomeReason(hops)).toBe('network-error');
  });

  it('should be null when the failure carried a real status code', () => {
    expect(outcomeReason(parseTrace(FAILED_400).hops)).toBeNull();
  });

  it('should be null when nothing failed', () => {
    expect(outcomeReason(parseTrace(SUCCESS).hops)).toBeNull();
  });
});

describe('renderTimeline', () => {
  it('should mark the failing hop so the eye lands on it', () => {
    const out = renderTimeline(parseTrace(FAILED_400).hops);
    const line = out.find((l) => l.includes('upstream.attempt.outcome'));
    expect(line).toMatch(/❌|✗/);
    expect(line).toContain('400');
  });

  it('should not mark successful hops as failures', () => {
    const out = renderTimeline(parseTrace(SUCCESS).hops);
    expect(out.join('\n')).not.toMatch(/❌/);
  });

  it('should include the retry delays when a ladder is present', () => {
    const out = renderTimeline(parseTrace(RETRIED_429).hops);
    expect(out.join('\n')).toMatch(/1000|2000|4000/);
  });

  it('should return one line per hop', () => {
    expect(renderTimeline(parseTrace(SUCCESS).hops)).toHaveLength(7);
  });
});
