import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../../core/graph/GraphStore';
import { ClearanceLevel } from '../../core/security/Clearance';
import { describe, expect, it } from 'bun:test';

describe('GraphStore', () => {
  it('upserts nodes/edges and merges properties on repeated calls', () => {
    const graph = new GraphStore();
    graph.upsertNode({ id: 'a', type: 'Person', label: 'Alice', properties: { role: 'CPO' } });
    graph.upsertNode({ id: 'b', type: 'Organization', label: 'Shell Co' });
    graph.upsertEdge({ source: 'a', target: 'b', relation: 'AFFILIATED_WITH', properties: { confidence: 0.9 } });

    graph.upsertNode({ id: 'a', type: 'Person', label: 'Alice', properties: { risk_score: 80 } });
    const node = graph.getNode('a')!;
    expect(node.properties).toEqual({ role: 'CPO', risk_score: 80 });
  });

  it('refuses an edge referencing an unknown node', () => {
    const graph = new GraphStore();
    graph.upsertNode({ id: 'a', type: 'Person', label: 'Alice' });
    expect(() => graph.upsertEdge({ source: 'a', target: 'ghost', relation: 'X' })).toThrow(/unknown node/);
  });

  it('filters nodes/edges by clearance', () => {
    const graph = new GraphStore();
    graph.upsertNode({ id: 'a', type: 'Person', label: 'Alice', clearance: ClearanceLevel.PUBLIC });
    graph.upsertNode({ id: 'b', type: 'Organization', label: 'Secret Corp', clearance: ClearanceLevel.SECRET });
    graph.upsertEdge({ source: 'a', target: 'b', relation: 'KNOWS', clearance: ClearanceLevel.SECRET });

    expect(graph.getNode('b', ClearanceLevel.PUBLIC)).toBeNull();
    expect(graph.getNode('b', ClearanceLevel.SECRET)).not.toBeNull();
    expect(graph.neighbors('a', ClearanceLevel.PUBLIC)).toHaveLength(0);
    expect(graph.neighbors('a', ClearanceLevel.SECRET)).toHaveLength(1);
  });

  it('finds the shortest path across a chain, respecting clearance', () => {
    const graph = new GraphStore();
    graph.upsertNode({ id: 'a', type: 'Person', label: 'A' });
    graph.upsertNode({ id: 'b', type: 'Organization', label: 'B' });
    graph.upsertNode({ id: 'c', type: 'Asset', label: 'C' });
    graph.upsertEdge({ source: 'a', target: 'b', relation: 'R1' });
    graph.upsertEdge({ source: 'b', target: 'c', relation: 'R2', clearance: ClearanceLevel.TOP_SECRET });

    const openPath = graph.shortestPath('a', 'c', ClearanceLevel.PUBLIC);
    expect(openPath).toBeNull();

    const fullPath = graph.shortestPath('a', 'c', ClearanceLevel.TOP_SECRET);
    expect(fullPath?.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(fullPath?.edges.map((e) => e.relation)).toEqual(['R1', 'R2']);
  });

  it('expands a local subgraph up to N hops without duplicates', () => {
    const graph = new GraphStore();
    graph.upsertNode({ id: 'a', type: 'Person', label: 'A' });
    graph.upsertNode({ id: 'b', type: 'Organization', label: 'B' });
    graph.upsertNode({ id: 'c', type: 'Asset', label: 'C' });
    graph.upsertEdge({ source: 'a', target: 'b', relation: 'R1' });
    graph.upsertEdge({ source: 'b', target: 'c', relation: 'R2' });

    const oneHop = graph.expand('a', 1);
    expect(oneHop.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);

    const twoHop = graph.expand('a', 2);
    expect(twoHop.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(twoHop.edges).toHaveLength(2);
  });

  it('runBatch defers persistence until the batch completes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-batch-test-'));
    const filePath = path.join(dir, 'graph.json');
    const graph = new GraphStore(filePath);

    graph.runBatch(() => {
      graph.upsertNode({ id: 'a', type: 'Person', label: 'Alice' });
      graph.upsertNode({ id: 'b', type: 'Organization', label: 'Shell Co' });
      graph.upsertEdge({ source: 'a', target: 'b', relation: 'AFFILIATED_WITH' });
      // Nothing is written while the batch is still running.
      expect(fs.existsSync(filePath)).toBe(false);
    });

    const reloaded = new GraphStore(filePath);
    expect(reloaded.getNode('a')?.label).toBe('Alice');
    expect(reloaded.getNode('b')?.label).toBe('Shell Co');
    expect(reloaded.neighbors('a')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists to disk and reloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));
    const filePath = path.join(dir, 'graph.json');
    const graph1 = new GraphStore(filePath);
    graph1.upsertNode({ id: 'a', type: 'Person', label: 'Alice' });

    const graph2 = new GraphStore(filePath);
    expect(graph2.getNode('a')?.label).toBe('Alice');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
