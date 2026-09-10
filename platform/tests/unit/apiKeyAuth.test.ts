import { EnvApiKeyAuth } from '../../core/security/ApiKeyAuth';
import { ClearanceLevel } from '../../core/security/Clearance';
import { describe, expect, it } from 'bun:test';

describe('EnvApiKeyAuth', () => {
  it('resolves a configured key to its clearance level', () => {
    const auth = new EnvApiKeyAuth(JSON.stringify({ 'demo-analyst': 'CONFIDENTIAL', 'demo-public': 'PUBLIC' }));
    expect(auth.resolveClearance('demo-analyst')).toBe(ClearanceLevel.CONFIDENTIAL);
    expect(auth.resolveClearance('demo-public')).toBe(ClearanceLevel.PUBLIC);
  });

  it('returns null for an unknown key instead of a default clearance', () => {
    const auth = new EnvApiKeyAuth(JSON.stringify({ 'demo-analyst': 'CONFIDENTIAL' }));
    expect(auth.resolveClearance('not-a-real-key')).toBeNull();
  });

  it('treats an empty configuration as no valid keys', () => {
    const auth = new EnvApiKeyAuth(undefined);
    expect(auth.resolveClearance('anything')).toBeNull();
  });
});

describe('EnvApiKeyAuth: principals', () => {
  it('names a principal from the long form, so the audit trail can say who', () => {
    const auth = new EnvApiKeyAuth(
      JSON.stringify({
        'k-olena': { principal: 'olena', clearance: 'SECRET', compartments: ['grid-topology'], purposes: ['outage-response'] },
      }),
    );
    const principal = auth.resolvePrincipal('k-olena')!;
    expect(principal.id).toBe('olena');
    expect(principal.clearance).toBe(ClearanceLevel.SECRET);
    expect(principal.compartments).toEqual(['grid-topology']);
    expect(principal.purposes).toEqual(['outage-response']);
  });

  it('resolves the short form unchanged, in no compartments', () => {
    // Every deployment currently running uses this shape. Upgrading must not
    // silently change what such a key can read, and it must not silently put
    // it into every circle either - so: same level, no compartments.
    const auth = new EnvApiKeyAuth(JSON.stringify({ 'demo-analyst': 'CONFIDENTIAL' }));
    const principal = auth.resolvePrincipal('demo-analyst')!;
    expect(principal.clearance).toBe(ClearanceLevel.CONFIDENTIAL);
    expect(principal.compartments).toEqual([]);
    expect(principal.purposes).toEqual([]);
  });

  it('names an unnamed key after its own hash, never after the key', () => {
    const auth = new EnvApiKeyAuth(JSON.stringify({ 'demo-analyst': 'CONFIDENTIAL' }));
    const id = auth.resolvePrincipal('demo-analyst')!.id;
    expect(id.startsWith('key:')).toBe(true);
    expect(id).not.toContain('demo-analyst');
    // Stable across restarts, or the audit trail cannot be joined up.
    expect(new EnvApiKeyAuth(JSON.stringify({ 'demo-analyst': 'X' })).resolvePrincipal('demo-analyst')!.id).toBe(id);
  });

  it('throws on a malformed compartment rather than resolving it to none', () => {
    const auth = new EnvApiKeyAuth(JSON.stringify({ bad: { clearance: 'SECRET', compartments: ['not a compartment'] } }));
    expect(() => auth.resolvePrincipal('bad')).toThrow();
  });

  it('still answers the clearance-only question the rest of the code asks', () => {
    const auth = new EnvApiKeyAuth(JSON.stringify({ k: { principal: 'p', clearance: 'SECRET' } }));
    expect(auth.resolveClearance('k')).toBe(ClearanceLevel.SECRET);
    expect(auth.resolveClearance('nope')).toBeNull();
  });
});
