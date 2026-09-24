import { describe, it, expect } from 'vitest';
import { salvageBody, compareToFailure, renderSalvage } from '../src/body-salvage.mjs';

/**
 * The folded-body fixtures reproduce CCR's exact elision shape, captured from a
 * real log: the head and tail survive, the middle is cut out and replaced by
 * " ... N bytes omitted from preview ... ". That marker breaks the JSON while
 * request_body_truncated stays 0 — so the body looks complete and parses as
 * nothing.
 */
const FOLDED_ANTHROPIC =
  '{"model":"deepseek-flash","messages":[{"role":"user","content":[{"type":"text","text":"<system>hello' +
  ' ... 82095 bytes omitted from preview ... ' +
  'rest of the prompt"}]}],"max_tokens":2112,"stream":true}';

const FOLDED_OPENAI =
  '{"model":"agnes-3.0-flash","messages":[{"role":"system","content":"You are a security monitor' +
  ' ... 41230 bytes omitted from preview ... ' +
  'begin with <block>."}],"max_tokens":2112}';

const INTACT = JSON.stringify({
  model: 'tierflow',
  messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
  max_tokens: 2112,
});

describe('salvageBody', () => {
  it('should pull the model out of a folded body', () => {
    expect(salvageBody(FOLDED_ANTHROPIC).model).toBe('deepseek-flash');
    expect(salvageBody(FOLDED_OPENAI).model).toBe('agnes-3.0-flash');
  });

  it('should report the body as folded and how much was cut', () => {
    const s = salvageBody(FOLDED_ANTHROPIC);
    expect(s.folded).toBe(true);
    expect(s.omittedBytes).toBe(82095);
  });

  it('should report the top-level keys it could see in the head', () => {
    expect(salvageBody(FOLDED_ANTHROPIC).topKeys).toContain('model');
    expect(salvageBody(FOLDED_ANTHROPIC).topKeys).toContain('messages');
  });

  it('should count the messages it can see, even in a folded body', () => {
    // The count is a floor, not a total — the middle was cut out.
    expect(salvageBody(FOLDED_ANTHROPIC).messageCount).toBeGreaterThanOrEqual(1);
  });

  it('should parse an intact body fully', () => {
    const s = salvageBody(INTACT);
    expect(s.folded).toBe(false);
    expect(s.model).toBe('tierflow');
    expect(s.messageCount).toBe(2);
    expect(s.topKeys).toEqual(['model', 'messages', 'max_tokens']);
  });

  it('should extract max_tokens when present', () => {
    expect(salvageBody(INTACT).maxTokens).toBe(2112);
    expect(salvageBody(FOLDED_ANTHROPIC).maxTokens).toBe(2112);
  });

  it('should report a missing model as null, not as a string', () => {
    const noModel = '{"messages":[{"role":"user","content":"hi"}],"max_tokens":100}';
    expect(salvageBody(noModel).model).toBeNull();
  });

  it('should handle an empty or absent body without throwing', () => {
    for (const v of ['', null, undefined]) {
      const s = salvageBody(v);
      expect(s.model).toBeNull();
      expect(s.folded).toBe(false);
    }
  });

  it('should handle a non-JSON body without throwing', () => {
    const s = salvageBody('<html>502 Bad Gateway</html>');
    expect(s.model).toBeNull();
    expect(s.folded).toBe(false);
  });

  it('should not be fooled by the word model inside a message', () => {
    // A prompt that talks about models must not be read as the request's model.
    const body = '{"messages":[{"role":"user","content":"set \\"model\\": \\"gpt-4\\" in your config"}],"max_tokens":10}';
    expect(salvageBody(body).model).toBeNull();
  });

  it('should keep the model when it is not the first key', () => {
    const body = '{"max_tokens":100,"stream":true,"model":"deepseek-flash","messages":[]}';
    expect(salvageBody(body).model).toBe('deepseek-flash');
  });
});

describe('compareToFailure', () => {
  it('should confirm the model was present when the body carried one', () => {
    // This is the answer to "Missing model in request body": the client DID
    // send it, so the fault is downstream of the client.
    const v = compareToFailure({ model: 'deepseek-flash', present: true }, { requested_model: 'tokenrhythm7/deepseek-flash', status_code: 400 });
    expect(v.verdict).toBe('model-present');
    expect(v.detail).toMatch(/client/i);
  });

  it('should flag a genuinely absent model as a client-side fault', () => {
    const v = compareToFailure({ model: null, present: true }, { requested_model: 'x/y', status_code: 400 });
    expect(v.verdict).toBe('model-absent');
    expect(v.detail).toMatch(/client/i);
  });

  it('should note when the salvaged model differs from what was routed', () => {
    const v = compareToFailure({ model: 'a', present: true }, { requested_model: 'b', status_code: 400 });
    expect(v.verdict).toBe('model-mismatch');
  });

  it('should not claim a missing model when no body was stored at all', () => {
    // A stored-but-absent body and a never-stored body are different facts.
    // Concluding "the client sent no model" from an absent body would be a
    // fabrication — there is simply no evidence.
    const v = compareToFailure(salvageBody(null), { requested_model: 'x/y', status_code: 499 });
    expect(v.verdict).toBe('unknown');
  });

  it('should mark a body as present once one is actually read', () => {
    expect(salvageBody(INTACT).present).toBe(true);
    expect(salvageBody(FOLDED_ANTHROPIC).present).toBe(true);
    expect(salvageBody(null).present).toBe(false);
    expect(salvageBody('').present).toBe(false);
  });

  it('should stay silent when there is nothing to compare', () => {
    expect(compareToFailure(null, null).verdict).toBe('unknown');
    expect(compareToFailure(salvageBody(INTACT), null).verdict).toBe('unknown');
  });
});

describe('renderSalvage', () => {
  it('should say the body was folded and by how much', () => {
    const out = renderSalvage(salvageBody(FOLDED_ANTHROPIC));
    expect(out.join('\n')).toMatch(/folded|omitted/i);
    expect(out.join('\n')).toContain('82095');
  });

  it('should always surface the model line', () => {
    expect(renderSalvage(salvageBody(INTACT)).join('\n')).toContain('tierflow');
  });

  it('should state plainly when no model was found', () => {
    const out = renderSalvage(salvageBody('{"messages":[]}')).join('\n');
    expect(out).toMatch(/no .*model|model.*not|missing/i);
  });
});
