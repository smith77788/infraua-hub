import { describe, expect, it } from 'bun:test';
import { parseRule, validateCondition } from '../../core/alerts/AlertRule';
import { ClearanceLevel } from '../../core/security/Clearance';

const base = {
  id: 'test-rule',
  name: 'Тест',
  description: 'Що це означає для оператора',
  condition: { kind: 'entity', nodeType: 'Asset' },
};

describe('parsing a standing query', () => {
  it('keeps the defaults a rule does not state', () => {
    const rule = parseRule(base);
    expect(rule.enabled).toBe(true);
    expect(rule.severity).toBe('elevated');
    expect(rule.clearance).toBe(ClearanceLevel.PUBLIC);
    expect(rule.compartments).toEqual([]);
    expect(rule.reopenAfterMinutes).toBe(60);
  });

  it('insists on a description, because that is what gets read at 03:00', () => {
    expect(() => parseRule({ ...base, description: '' })).toThrow(/description/);
  });

  it('rejects an id that is not a short identifier', () => {
    expect(() => parseRule({ ...base, id: 'has spaces' })).toThrow();
  });
});

describe('condition validation', () => {
  it('refuses an unknown kind at the boundary, not at evaluation time', () => {
    // A rule that throws mid-sweep takes the whole sweep down with it, and the
    // alerts the *other* rules would have raised never happen. A monitoring
    // system that goes quiet on a typo is worse than none: silence reads as
    // "nothing is wrong".
    expect(() => validateCondition({ kind: 'telepathy' })).toThrow(/unknown condition kind/);
  });

  it('checks the shape of each kind', () => {
    expect(() => validateCondition({ kind: 'risk', minScore: 140 })).toThrow();
    expect(() => validateCondition({ kind: 'geofence', lat: 50, lon: 30, radiusKm: 0 })).toThrow();
    expect(() => validateCondition({ kind: 'proximity', nearType: 'Alien', radiusKm: 5 })).toThrow();
    expect(() => validateCondition({ kind: 'relation' })).toThrow();
    expect(() => validateCondition({ kind: 'all', of: [] })).toThrow();
  });

  it('requires a value for every operator except exists', () => {
    expect(() =>
      validateCondition({ kind: 'entity', properties: [{ property: 'voltage', op: 'gte' }] }),
    ).toThrow(/needs a value/);
    expect(() => validateCondition({ kind: 'entity', properties: [{ property: 'voltage', op: 'exists' }] })).not.toThrow();
  });

  it('validates nested branches, not just the top level', () => {
    expect(() => validateCondition({ kind: 'all', of: [{ kind: 'entity' }, { kind: 'nonsense' }] })).toThrow();
  });

  it('refuses a condition nested past a sane depth', () => {
    let nested: unknown = { kind: 'entity' };
    for (let i = 0; i < 8; i++) nested = { kind: 'all', of: [nested] };
    expect(() => validateCondition(nested)).toThrow(/deeper/);
  });
});
