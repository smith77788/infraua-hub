import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { describe, expect, it } from 'bun:test';

const manifest = new OntologyManifest({
  entity_types: {
    Person: { properties: [], default_clearance: 'PUBLIC' },
    Organization: { properties: [], default_clearance: 'PUBLIC' },
    Location: { properties: [], default_clearance: 'PUBLIC' },
  },
  edge_types: {
    AFFILIATED_WITH: { from: 'Person', to: 'Organization' },
    LOCATED_AT: { from: ['Person', 'Organization'], to: 'Location' },
  },
});

describe('OntologyManifest', () => {
  it('validates a declared relation with matching endpoint types', () => {
    expect(manifest.validateEdge('AFFILIATED_WITH', 'Person', 'Organization')).toEqual({ valid: true });
  });

  it('accepts any of several allowed source types', () => {
    expect(manifest.validateEdge('LOCATED_AT', 'Organization', 'Location').valid).toBe(true);
    expect(manifest.validateEdge('LOCATED_AT', 'Person', 'Location').valid).toBe(true);
  });

  it('rejects an undeclared relation name', () => {
    const result = manifest.validateEdge('SECRET_HANDSHAKE', 'Person', 'Organization');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not declared/);
  });

  it('rejects a declared relation with the wrong endpoint type', () => {
    const result = manifest.validateEdge('AFFILIATED_WITH', 'Organization', 'Person');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not permit/);
  });

  it('is enforced by GraphStore.upsertEdge when a manifest is supplied', () => {
    const graph = new GraphStore(undefined, manifest);
    graph.upsertNode({ id: 'a', type: 'Person', label: 'Alice' });
    graph.upsertNode({ id: 'b', type: 'Person', label: 'Bob' });

    expect(() => graph.upsertEdge({ source: 'a', target: 'b', relation: 'AFFILIATED_WITH' })).toThrow(/ontology manifest/);
  });

  it('does not restrict GraphStore when no manifest is supplied (backward compatible)', () => {
    const graph = new GraphStore();
    graph.upsertNode({ id: 'a', type: 'Person', label: 'Alice' });
    graph.upsertNode({ id: 'b', type: 'Person', label: 'Bob' });

    expect(() => graph.upsertEdge({ source: 'a', target: 'b', relation: 'ANYTHING_GOES' })).not.toThrow();
  });
});
