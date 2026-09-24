import { describe, it, expect } from 'vitest';
import {
  extractUpstreamError,
  classifyFailure,
  resolutionAnomaly,
  cacheOscillation,
  emptyErrorRate,
  exitCodeFor,
  overallLevel,
} from '../src/ccr-doctor.mjs';

/**
 * Fixtures below are verbatim response bodies captured from a real local CCR
 * request log. They are the whole reason this tool exists: CCR's own `error`
 * column said nothing for three of these four failures.
 */
const BODY_PAIRING = JSON.stringify({
  error: {
    message: 'The provided messages input is invalid. The error info is [Can only get item pairs from a mapping.].',
    type: 'invalid_request_error',
    param: '',
    code: 'invalid_parameter_error',
  },
});

const BODY_UNKNOWN_FIELD = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: '请求包含未知字段' },
  request_id: 'trace_1eba91c3',
});

const BODY_RATE_LIMIT = JSON.stringify({
  type: 'error',
  error: { type: 'rate_limit_error', message: '请求过于频繁' },
  request_id: 'trace_8e86a28d',
});

describe('extractUpstreamError', () => {
  it('should pull message and type out of the nested error object', () => {
    expect(extractUpstreamError(BODY_PAIRING)).toMatchObject({
      message: 'The provided messages input is invalid. The error info is [Can only get item pairs from a mapping.].',
      type: 'invalid_request_error',
      code: 'invalid_parameter_error',
    });
  });

  it('should handle the anthropic-style envelope where type sits at the top level', () => {
    expect(extractUpstreamError(BODY_UNKNOWN_FIELD)).toMatchObject({
      message: '请求包含未知字段',
      type: 'invalid_request_error',
    });
  });

  it('should return nulls rather than throwing on a non-JSON body', () => {
    expect(extractUpstreamError('<html>502 Bad Gateway</html>')).toMatchObject({ message: null, type: null });
  });

  it('should return nulls on an empty or missing body', () => {
    expect(extractUpstreamError('')).toMatchObject({ message: null, type: null });
    expect(extractUpstreamError(null)).toMatchObject({ message: null, type: null });
  });

  it('should not mistake a successful response body for an error', () => {
    // A 200 body carries a top-level "content"/"choices" and no "error" key.
    const ok = JSON.stringify({ id: 'chatcmpl-1', role: 'assistant', content: [] });
    expect(extractUpstreamError(ok)).toMatchObject({ message: null, type: null });
  });
});

describe('classifyFailure', () => {
  const row = (over = {}) => ({
    status_code: 400,
    error: '',
    response_body_text: null,
    request_body_size_bytes: 1024,
    duration_ms: 800,
    route_attempt_count: 1,
    ...over,
  });

  it('should name the orphan tool_use/tool_result pairing fault, not just echo the upstream text', () => {
    const d = classifyFailure(row({ response_body_text: BODY_PAIRING }));
    expect(d.class).toBe('tool-pairing');
    expect(d.cause).toMatch(/tool_use|tool_result/i);
    expect(d.action).toBeTruthy();
  });

  it('should name the unknown-field fault and point at the offending request', () => {
    const d = classifyFailure(row({ response_body_text: BODY_UNKNOWN_FIELD, request_body_size_bytes: 947776 }));
    expect(d.class).toBe('unknown-field');
    expect(d.action).toMatch(/field/i);
  });

  it('should classify 429 as rate limiting and surface the retry count', () => {
    const d = classifyFailure(row({ status_code: 429, response_body_text: BODY_RATE_LIMIT, route_attempt_count: 4 }));
    expect(d.class).toBe('rate-limited');
    expect(d.cause).toMatch(/4/);
  });

  it('should classify 499 with a closed connection as a client-side abort', () => {
    const d = classifyFailure(row({ status_code: 499, error: 'Client connection closed before response completed.' }));
    expect(d.class).toBe('client-abort');
  });

  it('should classify auth failures', () => {
    for (const code of [401, 403]) {
      expect(classifyFailure(row({ status_code: code })).class).toBe('auth');
    }
  });

  it('should fall back to "opaque" when CCR recorded no usable message anywhere', () => {
    // The headline case: status 400, empty error column, no captured body.
    const d = classifyFailure(row({ status_code: 400, error: '', response_body_text: '' }));
    expect(d.class).toBe('opaque');
    expect(d.action).toMatch(/body|log|preview/i);
  });

  it('should never return an empty action for any class it produces', () => {
    const rows = [
      row({ response_body_text: BODY_PAIRING }),
      row({ response_body_text: BODY_UNKNOWN_FIELD }),
      row({ status_code: 429, response_body_text: BODY_RATE_LIMIT }),
      row({ status_code: 499, error: 'Client connection closed before response completed.' }),
      row({ status_code: 401 }),
      row({ status_code: 400, response_body_text: '' }),
      row({ status_code: 500, response_body_text: 'upstream exploded' }),
    ];
    for (const r of rows) {
      const d = classifyFailure(r);
      expect(d.action, `class ${d.class} must carry an action`).toBeTruthy();
      expect(d.class).toBeTruthy();
    }
  });
});

describe('resolutionAnomaly', () => {
  it('should flag a protocol name that leaked into resolved_model on a SUCCESSFUL request', () => {
    // Captured: provider "agenes" resolved to "agenes::openai_chat_completions/agnes-3.0-flash"
    // on a 200 — the call worked, but the model id is now unusable as a key.
    const a = resolutionAnomaly({ status_code: 200, requested_model: 'agenes/agnes-3.0-flash', resolved_model: 'agenes::openai_chat_completions/agnes-3.0-flash', response_model: 'agnes-3.0-flash' });
    expect(a).toBeTruthy();
    expect(a).toMatch(/protocol/i);
  });

  it('should NOT re-report a missing response model on a request that already failed', () => {
    // Measured: all 6 such rows were requests the failure list already reports.
    // Repeating them as a second warning is noise, not a finding.
    const a = resolutionAnomaly({ status_code: 499, requested_model: 'tierflow/tierflow', resolved_model: 'tierflow', response_model: '' });
    expect(a).toBeNull();
  });

  it('should stay silent on a clean resolution chain', () => {
    expect(resolutionAnomaly({ status_code: 200, requested_model: 'tokenrhythm7/deepseek-flash', resolved_model: 'deepseek-flash', response_model: 'deepseek-flash' })).toBeNull();
  });

  it('should stay silent on a successful request with an empty response model field', () => {
    // A 200 with no response_model recorded is a logging gap, not a misrouting.
    expect(resolutionAnomaly({ status_code: 200, requested_model: 'x/y', resolved_model: 'y', response_model: '' })).toBeNull();
  });
});

describe('cacheOscillation', () => {
  const req = (cache_read, input) => ({ cache_read_tokens: cache_read, input_tokens: input });

  it('should detect a regression where the prefix stayed the same size but stopped hitting', () => {
    // The real signature: same prefix, cache collapsed. Measured on live data —
    // 76544/78003 hit, then 3200/79556 miss, on a prefix that barely moved.
    // Repeating it across the window is what makes it a finding rather than
    // cache TTL expiring.
    const rows = [
      req(76544, 1459), req(3200, 76356), req(81408, 1424), req(2900, 82000),
      req(82816, 1185), req(3000, 81000), req(83000, 1300), req(3100, 80000),
    ];
    const r = cacheOscillation(rows);
    expect(r.oscillating).toBe(true);
    expect(r.regressions).toBeGreaterThanOrEqual(3);
  });

  it('should stay quiet when regressions are a small share of a healthy path', () => {
    // Measured: tokenrhythm sat at 460 hit / 9 miss. A handful of cold starts
    // in a 98% cached path is not something to warn about.
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(req(27000 + i, 300));
    rows.push(req(0, 27500)); // one cold-ish miss whose prefix size happens to match
    rows.push(req(27100, 290));
    const r = cacheOscillation(rows);
    expect(r.oscillating).toBe(false);
    expect(r.regressions).toBeLessThan(3);
  });

  it('should NOT flag a new session that starts from a smaller prefix', () => {
    // Measured false positive: a long cached session (465K prefix) ends and a
    // new one begins (40K prefix). Different prefix = cold start, not drift.
    const rows = [
      req(465664, 1358), req(465664, 1358), req(465664, 1358),
      req(0, 40051), req(0, 71342), req(71168, 1199),
    ];
    const r = cacheOscillation(rows);
    expect(r.oscillating).toBe(false);
    expect(r.regressions).toBe(0);
  });

  it('should not cry drift on a steadily-cached path', () => {
    const r = cacheOscillation([req(27600, 200), req(27900, 150), req(27500, 300), req(27800, 180)]);
    expect(r.oscillating).toBe(false);
  });

  it('should not cry drift on a cold path that simply never cached', () => {
    const r = cacheOscillation([req(0, 28000), req(0, 28100), req(0, 27900)]);
    expect(r.oscillating).toBe(false);
  });

  it('should report the hit and miss counts it based its verdict on', () => {
    const r = cacheOscillation([req(27600, 200), req(0, 28000), req(27900, 150), req(27800, 180)]);
    expect(r.eligible).toBe(4);
    expect(r.hit + r.miss).toBe(4);
  });

  it('should ignore requests below the minimum cacheable size', () => {
    // Tiny requests always miss; averaging them in manufactures fake drift.
    const r = cacheOscillation([req(0, 40), req(0, 55), req(0, 30), req(0, 48)]);
    expect(r.oscillating).toBe(false);
    expect(r.eligible).toBe(0);
  });
});

describe('emptyErrorRate', () => {
  it('should measure how often CCR logged a failure with no message at all', () => {
    const rows = [
      { status_code: 400, error: '', response_body_text: '' },
      { status_code: 400, error: '', response_body_text: '' },
      { status_code: 400, error: 'boom', response_body_text: '' },
      { status_code: 200, error: '', response_body_text: '' },
    ];
    const r = emptyErrorRate(rows);
    expect(r.failures).toBe(3);
    expect(r.empty).toBe(2);
    expect(r.rate).toBeCloseTo(2 / 3, 5);
  });

  it('should report a null rate when there are no failures at all', () => {
    const r = emptyErrorRate([{ status_code: 200, error: '', response_body_text: '' }]);
    expect(r.failures).toBe(0);
    expect(r.rate).toBeNull();
  });
});

describe('exit codes', () => {
  it('should exit 1 when a diagnosis is a hard failure', () => {
    expect(exitCodeFor([{ level: 'fail' }, { level: 'ok' }])).toBe(1);
  });

  it('should exit 0 on warnings only, so a noisy gateway does not break CI', () => {
    expect(exitCodeFor([{ level: 'warn' }, { level: 'ok' }])).toBe(0);
  });

  it('should rank fail above warn above ok', () => {
    expect(overallLevel([{ level: 'ok' }, { level: 'warn' }, { level: 'fail' }])).toBe('fail');
    expect(overallLevel([{ level: 'ok' }, { level: 'warn' }])).toBe('warn');
    expect(overallLevel([])).toBe('ok');
  });
});
