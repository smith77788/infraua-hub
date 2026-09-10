import { describe, expect, it } from 'bun:test';
import { ClearanceLevel } from '../../core/security/Clearance';
import {
  asViewer,
  canRead,
  mergeCompartments,
  normalizeCompartment,
  normalizeCompartments,
  unionCompartments,
  viewer,
} from '../../core/security/Marking';

describe('compartment names', () => {
  it('lowercases and trims so one circle does not become three', () => {
    expect(normalizeCompartment('  Grid-Topology ')).toBe('grid-topology');
  });

  it('rejects anything that is not a short identifier', () => {
    expect(() => normalizeCompartment('grid topology')).toThrow();
    expect(() => normalizeCompartment('-leading-dash')).toThrow();
    expect(() => normalizeCompartment('x'.repeat(65))).toThrow();
    expect(() => normalizeCompartment('')).toThrow();
  });

  it('parses both a list and the comma-separated form a header carries', () => {
    expect(normalizeCompartments(['b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeCompartments('b, a')).toEqual(['a', 'b']);
    expect(normalizeCompartments(undefined)).toEqual([]);
  });

  it('deduplicates and sorts, so two orderings of one set compare equal', () => {
    expect(normalizeCompartments(['b', 'a', 'B'])).toEqual(['a', 'b']);
  });

  it('refuses a malformed list rather than resolving it to no compartments', () => {
    // Resolving to [] would widen the marking on a typo - the wrong direction.
    expect(() => normalizeCompartments(['ok', 'not ok'])).toThrow();
    expect(() => normalizeCompartments(42)).toThrow();
  });
});

describe('canRead', () => {
  const secretInGrid = { clearance: ClearanceLevel.SECRET, compartments: ['grid'] };

  it('requires the level and every compartment', () => {
    expect(canRead(viewer(ClearanceLevel.SECRET, ['grid']), secretInGrid)).toBe(true);
    expect(canRead(viewer(ClearanceLevel.TOP_SECRET, ['grid']), secretInGrid)).toBe(true);
    // Cleared high enough, not read in: refused. This is the whole point.
    expect(canRead(viewer(ClearanceLevel.TOP_SECRET, []), secretInGrid)).toBe(false);
    expect(canRead(viewer(ClearanceLevel.INTERNAL, ['grid']), secretInGrid)).toBe(false);
  });

  it('requires all compartments, not any of them', () => {
    const both = { clearance: ClearanceLevel.PUBLIC, compartments: ['grid', 'pii'] };
    expect(canRead(viewer(ClearanceLevel.PUBLIC, ['grid']), both)).toBe(false);
    expect(canRead(viewer(ClearanceLevel.PUBLIC, ['grid', 'pii']), both)).toBe(true);
  });

  it('treats a bare clearance as a reader in no compartments', () => {
    expect(canRead(ClearanceLevel.TOP_SECRET, { clearance: ClearanceLevel.SECRET })).toBe(true);
    expect(canRead(ClearanceLevel.TOP_SECRET, secretInGrid)).toBe(false);
    expect(asViewer(ClearanceLevel.SECRET).compartments.size).toBe(0);
  });

  it('lets an unmarked record through on the level alone', () => {
    expect(canRead(viewer(ClearanceLevel.PUBLIC, []), { clearance: ClearanceLevel.PUBLIC })).toBe(true);
    expect(canRead(viewer(ClearanceLevel.PUBLIC, []), { clearance: ClearanceLevel.PUBLIC, compartments: [] })).toBe(true);
  });
});

describe('merging markings', () => {
  it('unions rather than replaces, so a re-ingest cannot strip a marking', () => {
    expect(mergeCompartments(['grid'], [])).toEqual(['grid']);
    expect(mergeCompartments(['grid'], undefined)).toEqual(['grid']);
    expect(mergeCompartments(['grid'], ['pii'])).toEqual(['grid', 'pii']);
  });

  it('stays empty when nothing is marked', () => {
    expect(mergeCompartments(undefined, undefined)).toEqual([]);
  });

  it('unions a set of records into what it takes to read all of them', () => {
    expect(unionCompartments([['grid'], undefined, ['pii', 'grid']])).toEqual(['grid', 'pii']);
  });
});
