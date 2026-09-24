import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * The release workflow only runs on a tag, which is the worst moment to find
 * out it is broken — the version is already cut and the tag is public. These
 * assertions pin the parts that fail *silently* or *late* otherwise.
 */
const PATH = '.github/workflows/release.yml';
const src = readFileSync(PATH, 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/** Crude but sufficient: pull a top-level block out of the workflow by indent. */
const block = (key) => {
  const m = new RegExp(`^${key}:.*$`, 'm').exec(src);
  return m ? m[0] : '';
};

describe('release workflow', () => {
  it('should exist', () => {
    expect(existsSync(PATH)).toBe(true);
  });

  it('should trigger on v* tags', () => {
    expect(src).toMatch(/tags:\s*\['v\*'\]/);
  });

  it('should request id-token write, without which OIDC silently falls back to no auth', () => {
    // npm's oidc() returns undefined when ACTIONS_ID_TOKEN_REQUEST_URL is
    // absent, and a missing `id-token: write` is exactly what removes it. The
    // failure then looks like a plain auth error, not a permissions error.
    expect(src).toMatch(/id-token:\s*write/);
  });

  it('should publish with provenance', () => {
    expect(src).toContain('--provenance');
  });

  it('should not pass the token to npm under a name npm reads when it may be empty', () => {
    // NODE_AUTH_TOKEN must be exported inside the shell, gated on non-empty,
    // never supplied via `env:` where an unset secret becomes an empty string
    // that npm would see as a credential.
    const publishStep = src.slice(src.indexOf('name: Publish to npm'));
    expect(publishStep).toContain('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(publishStep).toMatch(/export NODE_AUTH_TOKEN="\$NPM_TOKEN"/);
    expect(publishStep).not.toMatch(/env:\s*\n\s*NODE_AUTH_TOKEN:/);
  });

  it('should guard the publish step on dry_run', () => {
    const publishStep = src.slice(src.indexOf('name: Publish to npm'));
    expect(publishStep).toContain('if: ${{ !inputs.dry_run }}');
  });

  it('should run the tests before publishing', () => {
    const testAt = src.indexOf('run: npm test');
    const publishAt = src.indexOf('name: Publish to npm');
    expect(testAt).toBeGreaterThan(-1);
    expect(testAt).toBeLessThan(publishAt);
  });

  it('should verify the tag matches package.json before publishing', () => {
    expect(src).toContain('Tag agrees with package.json version');
    expect(src.indexOf('Tag agrees')).toBeLessThan(src.indexOf('name: Publish to npm'));
  });

  it('should publish to the public npm registry explicitly', () => {
    // The local dev machine points npm at a mirror; a workflow that inherits a
    // registry would publish somewhere unintended or not at all.
    expect(src).toContain("registry-url: 'https://registry.npmjs.org'");
    expect(src).toContain('--access public');
  });

  it('should keep package.json repository pointing at the publishing repo', () => {
    // Provenance verifies this against the OIDC claims; a mismatch fails the
    // publish after the tag is already pushed.
    expect(pkg.repository?.url).toContain('github.com/acrot0/ccr-toolkit');
  });

  it('should document that the first release cannot use OIDC', () => {
    // The bootstrap limitation is the single non-obvious thing about this
    // setup. If the comment goes, the next person adds a Trusted Publisher,
    // deletes the token, and cannot publish at all.
    expect(src).toMatch(/cannot bootstrap/i);
    expect(src).toMatch(/trusted publishing/i);
  });
});
