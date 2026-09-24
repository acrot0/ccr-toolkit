import { describe, it, expect } from 'vitest';
import { resolveCommand, COMMANDS, summarize } from '../src/cli.mjs';

describe('resolveCommand', () => {
  it('should map each short name to its tool', () => {
    expect(resolveCommand('doctor')).toBe('./ccr-doctor.mjs');
    expect(resolveCommand('trace')).toBe('./trace-view.mjs');
    expect(resolveCommand('body')).toBe('./body-salvage.mjs');
    expect(resolveCommand('cache')).toBe('./cache-monitor.mjs');
    expect(resolveCommand('check')).toBe('./ccr-check.mjs');
    expect(resolveCommand('takeover')).toBe('./ccr-takeover-audit.mjs');
  });

  it('should accept a leading dash form, since both are muscle memory', () => {
    expect(resolveCommand('--doctor')).toBe('./ccr-doctor.mjs');
    expect(resolveCommand('-d')).toBeNull(); // no single-letter aliases to guess at
  });

  it('should return null for an unknown command rather than guessing', () => {
    expect(resolveCommand('frobnicate')).toBeNull();
    expect(resolveCommand('')).toBeNull();
    expect(resolveCommand(null)).toBeNull();
  });

  it('should expose every command it can resolve', () => {
    for (const [name, file] of Object.entries(COMMANDS)) {
      expect(resolveCommand(name), `${name} must resolve`).toBe(file);
    }
  });
});

describe('summarize', () => {
  const r = (name, level, extra = {}) => ({ name, level, ...extra });

  it('should report the worst level across all tools', () => {
    const s = summarize([r('doctor', 'ok'), r('check', 'warn'), r('cache', 'ok')]);
    expect(s.level).toBe('warn');
  });

  it('should rank fail above warn above ok', () => {
    expect(summarize([r('a', 'ok'), r('b', 'fail'), r('c', 'warn')]).level).toBe('fail');
  });

  it('should count failures and warnings separately', () => {
    const s = summarize([r('a', 'fail'), r('b', 'fail'), r('c', 'warn'), r('d', 'ok')]);
    expect(s.failed).toBe(2);
    expect(s.warned).toBe(1);
    expect(s.ok).toBe(1);
  });

  it('should list only the tools that need attention', () => {
    const s = summarize([r('a', 'ok'), r('b', 'fail'), r('c', 'warn')]);
    expect(s.attention.map((x) => x.name)).toEqual(['b', 'c']);
  });

  it('should treat an empty run as ok, not as a failure', () => {
    const s = summarize([]);
    expect(s.level).toBe('ok');
    expect(s.attention).toEqual([]);
  });

  it('should carry a tool that could not run as unknown rather than dropping it', () => {
    // A tool that crashed tells you nothing — silently omitting it would make
    // the summary claim more coverage than it has.
    const s = summarize([r('a', 'ok'), { name: 'b', level: 'unknown', error: 'boom' }]);
    expect(s.attention.map((x) => x.name)).toContain('b');
    expect(s.level).not.toBe('ok');
  });
});
