import {
  allShortestPaths,
  betweenness,
  bridges,
  components,
  degrees,
} from '../../core/analytics/GraphMetrics';
import { ClearanceLevel } from '../../core/security/Clearance';
import { GraphEdge, GraphNode, NodeType } from '../../core/graph/types';
import { describe, expect, it } from 'bun:test';

function node(id: string, type: NodeType = 'Person'): GraphNode {
  return {
    id,
    type,
    label: id.toUpperCase(),
    properties: {},
    clearance: ClearanceLevel.PUBLIC,
    source_doc_ids: [],
  };
}

function edge(source: string, target: string, relation = 'AFFILIATED_WITH'): GraphEdge {
  return {
    source,
    target,
    relation,
    properties: {},
    clearance: ClearanceLevel.PUBLIC,
    source_doc_ids: [],
  };
}

describe('degrees', () => {
  it('counts undirected degree while keeping direction available', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('a', 'c')];

    const result = degrees(nodes, edges);
    const a = result.find((d) => d.id === 'a')!;
    const b = result.find((d) => d.id === 'b')!;

    expect(a.degree).toBe(2);
    expect(a.outDegree).toBe(2);
    expect(a.inDegree).toBe(0);
    expect(b.degree).toBe(1);
    expect(b.inDegree).toBe(1);
  });

  it('ignores edges pointing outside the snapshot', () => {
    // This is the clearance case: an edge to a node the caller cannot see must
    // not inflate the degree of one they can, or the count reveals the hidden
    // node exists.
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b'), edge('a', 'hidden')];

    const a = degrees(nodes, edges).find((d) => d.id === 'a')!;
    expect(a.degree).toBe(1);
  });

  it('does not count a self-loop as a relation to another entity', () => {
    const nodes = [node('a')];
    expect(degrees(nodes, [edge('a', 'a')])[0].degree).toBe(0);
  });
});

describe('betweenness', () => {
  it('ranks the broker on a path graph above its endpoints', () => {
    // a — b — c: every shortest path between a and c runs through b.
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c')];

    const result = betweenness(nodes, edges);
    const byId = new Map(result.map((r) => [r.id, r]));

    expect(byId.get('b')!.raw).toBe(1);
    expect(byId.get('a')!.raw).toBe(0);
    expect(byId.get('c')!.raw).toBe(0);
    expect(result[0].id).toBe('b');
  });

  it('finds the low-degree broker that a degree ranking misses', () => {
    // Two triangles joined only through `broker`, which has degree 2 while the
    // cluster members have degree 3. This is the shell-company shape.
    const nodes = ['x1', 'x2', 'x3', 'broker', 'y1', 'y2', 'y3'].map((id) => node(id));
    const edges = [
      edge('x1', 'x2'),
      edge('x2', 'x3'),
      edge('x3', 'x1'),
      edge('x1', 'broker'),
      edge('broker', 'y1'),
      edge('y1', 'y2'),
      edge('y2', 'y3'),
      edge('y3', 'y1'),
    ];

    const topByBetweenness = betweenness(nodes, edges)[0];
    const topByDegree = degrees(nodes, edges)[0];

    expect(topByBetweenness.id).toBe('broker');
    expect(topByBetweenness.score).toBe(1);
    expect(topByDegree.id).not.toBe('broker');
  });

  it('gives every node zero on a complete graph, where nobody brokers anything', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')];

    for (const entry of betweenness(nodes, edges)) {
      expect(entry.raw).toBe(0);
    }
  });

  it('splits credit between two equally-short routes', () => {
    // a—b—d and a—c—d: b and c each carry half of the a→d flow.
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('b', 'd'), edge('a', 'c'), edge('c', 'd')];

    const byId = new Map(betweenness(nodes, edges).map((r) => [r.id, r]));
    expect(byId.get('b')!.raw).toBeCloseTo(0.5, 5);
    expect(byId.get('c')!.raw).toBeCloseTo(0.5, 5);
  });

  it('handles a disconnected graph without counting unreachable pairs', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('c', 'd')];

    for (const entry of betweenness(nodes, edges)) {
      expect(entry.raw).toBe(0);
    }
  });

  it('returns an empty result for an empty graph rather than throwing', () => {
    expect(betweenness([], [])).toEqual([]);
  });
});

describe('components', () => {
  it('groups reachable nodes and orders largest first', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id));
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('d', 'e')];

    const result = components(nodes, edges);
    expect(result).toHaveLength(2);
    expect(result[0].size).toBe(3);
    expect(result[0].members.sort()).toEqual(['a', 'b', 'c']);
    expect(result[1].size).toBe(2);
  });

  it('counts an isolated node as its own component', () => {
    const result = components([node('a'), node('b')], []);
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.size === 1)).toBe(true);
  });
});

describe('bridges', () => {
  it('finds the single edge holding two clusters together', () => {
    const nodes = ['x1', 'x2', 'x3', 'y1', 'y2', 'y3'].map((id) => node(id));
    const edges = [
      edge('x1', 'x2'),
      edge('x2', 'x3'),
      edge('x3', 'x1'),
      edge('x1', 'y1'),
      edge('y1', 'y2'),
      edge('y2', 'y3'),
      edge('y3', 'y1'),
    ];

    const found = bridges(nodes, edges);
    expect(found).toHaveLength(1);
    expect([found[0].source, found[0].target].sort()).toEqual(['x1', 'y1']);
  });

  it('finds no bridge in a cycle, where every edge has an alternative route', () => {
    const nodes = [node('a'), node('b'), node('c')];
    expect(bridges(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')])).toHaveLength(0);
  });

  it('treats every edge of a tree as a bridge', () => {
    const nodes = [node('a'), node('b'), node('c')];
    expect(bridges(nodes, [edge('a', 'b'), edge('b', 'c')])).toHaveLength(2);
  });
});

describe('allShortestPaths', () => {
  it('returns every equally-short route, not just one', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('b', 'd'), edge('a', 'c'), edge('c', 'd')];

    const paths = allShortestPaths(nodes, edges, 'a', 'd');
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(path).toHaveLength(3);
      expect(path[0]).toBe('a');
      expect(path[2]).toBe('d');
    }
    expect(paths.map((p) => p[1]).sort()).toEqual(['b', 'c']);
  });

  it('excludes longer routes once a shorter one exists', () => {
    // a—b—d is two hops; a—c—e—d is three and must not appear.
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id));
    const edges = [edge('a', 'b'), edge('b', 'd'), edge('a', 'c'), edge('c', 'e'), edge('e', 'd')];

    const paths = allShortestPaths(nodes, edges, 'a', 'd');
    expect(paths).toEqual([['a', 'b', 'd']]);
  });

  it('returns nothing when the two entities are not connected', () => {
    const nodes = [node('a'), node('b')];
    expect(allShortestPaths(nodes, [], 'a', 'b')).toEqual([]);
  });

  it('returns nothing for an id outside the snapshot', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b')];
    expect(allShortestPaths(nodes, edges, 'a', 'not-visible')).toEqual([]);
  });

  it('caps the number of paths returned', () => {
    // A hub-and-spoke between a and z gives one path per spoke.
    const spokes = ['s1', 's2', 's3', 's4', 's5'];
    const nodes = [node('a'), node('z'), ...spokes.map((id) => node(id))];
    const edges = spokes.flatMap((s) => [edge('a', s), edge(s, 'z')]);

    expect(allShortestPaths(nodes, edges, 'a', 'z')).toHaveLength(5);
    expect(allShortestPaths(nodes, edges, 'a', 'z', 2)).toHaveLength(2);
  });
});
