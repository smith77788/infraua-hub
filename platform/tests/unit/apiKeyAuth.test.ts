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
