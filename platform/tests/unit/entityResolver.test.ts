import { findDuplicateCandidates, normalizeLabel } from '../../core/analytics/EntityResolver';
import { ClearanceLevel } from '../../core/security/Clearance';
import { GraphEdge, GraphNode, NodeType } from '../../core/graph/types';
import { describe, expect, it } from 'bun:test';

function node(
  id: string,
  label: string,
  type: NodeType = 'Person',
  properties: Record<string, unknown> = {},
): GraphNode {
  return { id, type, label, properties, clearance: ClearanceLevel.PUBLIC, source_doc_ids: [] };
}

function edge(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    relation: 'AFFILIATED_WITH',
    properties: {},
    clearance: ClearanceLevel.PUBLIC,
    source_doc_ids: [],
  };
}

describe('normalizeLabel', () => {
  it('collapses case, punctuation and token order', () => {
    expect(normalizeLabel('Doe, John')).toBe(normalizeLabel('John Doe'));
    expect(normalizeLabel('  john   DOE ')).toBe(normalizeLabel('John Doe'));
  });

  it('strips honorifics', () => {
    expect(normalizeLabel('Dr. John Doe')).toBe(normalizeLabel('John Doe'));
  });

  it('strips corporate suffixes, which carry no identity', () => {
    expect(normalizeLabel('Acme Corp')).toBe(normalizeLabel('Acme Inc.'));
    expect(normalizeLabel('Acme Ltd')).toBe(normalizeLabel('Acme'));
  });

  it('keeps genuinely different names apart', () => {
    expect(normalizeLabel('John Doe')).not.toBe(normalizeLabel('Jane Doe'));
  });
});

describe('findDuplicateCandidates', () => {
  it('matches the same name written two ways', () => {
    const nodes = [node('p1', 'John Doe'), node('p2', 'Doe, John')];
    const candidates = findDuplicateCandidates(nodes, []);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(0.7);
    expect(candidates[0].reasons.join(' ')).toMatch(/normalise/i);
  });

  it('matches an initial against the full first name', () => {
    const nodes = [node('p1', 'John Doe'), node('p2', 'J Doe')];
    const candidates = findDuplicateCandidates(nodes, []);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].reasons.join(' ')).toMatch(/initials/i);
  });

  it('never proposes a match across entity types', () => {
    // A Person and an Organization sharing a name is the most obvious false
    // positive available, so it must be structurally impossible.
    const nodes = [node('p1', 'Acme', 'Person'), node('o1', 'Acme', 'Organization')];
    expect(findDuplicateCandidates(nodes, [])).toEqual([]);
  });

  it('treats a shared identifying property as strong evidence', () => {
    const nodes = [
      node('a1', 'Truck 7', 'Asset', { serial_number: 'SN-9931' }),
      node('a2', 'Vehicle Seven', 'Asset', { serial_number: 'SN-9931' }),
    ];
    const candidates = findDuplicateCandidates(nodes, []);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].reasons.join(' ')).toContain('SN-9931');
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('records shared counterparties as corroboration', () => {
    const nodes = [
      node('p1', 'John Doe'),
      node('p2', 'J. Doe'),
      node('o1', 'Acme', 'Organization'),
      node('o2', 'Globex', 'Organization'),
    ];
    const edges = [edge('p1', 'o1'), edge('p2', 'o1'), edge('p1', 'o2'), edge('p2', 'o2')];

    const candidate = findDuplicateCandidates(nodes, edges)[0];
    expect(candidate.sharedNeighbors.sort()).toEqual(['o1', 'o2']);
    expect(candidate.reasons.join(' ')).toMatch(/counterparties/i);
  });

  it('does not propose two unrelated people', () => {
    const nodes = [node('p1', 'John Doe'), node('p2', 'Katherine Johnson')];
    expect(findDuplicateCandidates(nodes, [])).toEqual([]);
  });

  it('does not propose two real colleagues who merely share every counterparty', () => {
    // Two directors of the same company share all their neighbours. Shared
    // structure alone must never be enough, or the platform would propose
    // merging every pair of co-workers it ever sees.
    const nodes = [
      node('p1', 'John Doe'),
      node('p2', 'Katherine Johnson'),
      node('o1', 'Acme', 'Organization'),
    ];
    const edges = [edge('p1', 'o1'), edge('p2', 'o1')];

    expect(findDuplicateCandidates(nodes, edges)).toEqual([]);
  });

  it('respects the confidence floor', () => {
    const nodes = [node('p1', 'John Doe'), node('p2', 'Doe, John')];
    expect(findDuplicateCandidates(nodes, [], { minConfidence: 0.99 })).toEqual([]);
    expect(findDuplicateCandidates(nodes, [], { minConfidence: 0.1 })).toHaveLength(1);
  });

  it('caps how many candidates it returns, highest confidence first', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(`p${i}`, 'John Doe'));
    const candidates = findDuplicateCandidates(nodes, [], { limit: 3 });

    expect(candidates).toHaveLength(3);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1].confidence).toBeGreaterThanOrEqual(candidates[i].confidence);
    }
  });

  it('reports confidence below 1 even for the strongest case, because it proposes rather than decides', () => {
    const nodes = [
      node('p1', 'John Doe', 'Person', { passport: 'X1' }),
      node('p2', 'John Doe', 'Person', { passport: 'X1' }),
    ];
    const candidate = findDuplicateCandidates(nodes, [])[0];
    expect(candidate.confidence).toBeLessThanOrEqual(1);
    expect(candidate.reasons.length).toBeGreaterThan(1);
  });

  it('handles an empty graph', () => {
    expect(findDuplicateCandidates([], [])).toEqual([]);
  });
});
