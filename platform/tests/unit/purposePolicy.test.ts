import { describe, expect, it } from 'bun:test';
import { PurposePolicy } from '../../core/security/PurposePolicy';

const policy = (overrides: Record<string, unknown> = {}) =>
  new PurposePolicy({
    access_purposes: {
      declared: { 'outage-response': 'Відновлення живлення', 'audit-review': 'Нагляд' },
      ...overrides,
    },
  });

describe('PurposePolicy', () => {
  it('lets an unrestricted key through with no purpose, and records none', () => {
    const decision = policy().check(undefined, []);
    expect(decision.allowed).toBe(true);
    expect(decision.purpose).toBeNull();
  });

  it('makes a key issued for named purposes say which one it is acting under', () => {
    // Otherwise the list on the key is decorative: it would constrain the
    // purposes you *may* name and not the requests you actually make.
    const decision = policy().check(undefined, ['outage-response']);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('refuses a purpose nobody declared, as a caller mistake', () => {
    const decision = policy().check('freelancing', []);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(400);
    expect(decision.reason).toContain('outage-response');
  });

  it('refuses a declared purpose this key was not issued for', () => {
    const decision = policy().check('audit-review', ['outage-response']);
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('accepts a purpose the key holds, normalised for the record', () => {
    const decision = policy().check('  Outage-Response ', ['outage-response']);
    expect(decision.allowed).toBe(true);
    expect(decision.purpose).toBe('outage-response');
  });

  it('is off unless a deployment turns it on', () => {
    expect(policy().isRequired).toBe(false);
    expect(policy({ require_purpose: true }).isRequired).toBe(true);
    // Turning it on with no purposes issued would lock every key out at once,
    // which is how a security control gets disabled instead of adopted.
    expect(policy({ require_purpose: true }).check(undefined, []).allowed).toBe(false);
    expect(policy({ require_purpose: true }).check('audit-review', []).allowed).toBe(true);
  });

  it('offers the catalogue so an operator is not guessing at names', () => {
    expect(policy().catalogue().map((p) => p.id)).toEqual(['audit-review', 'outage-response']);
  });
});
