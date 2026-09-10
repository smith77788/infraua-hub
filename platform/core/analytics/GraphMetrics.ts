import { GraphEdge, GraphNode } from '../graph/types';

/**
 * Structural analysis over a graph snapshot.
 *
 * Everything here takes an already clearance-filtered snapshot (what
 * GraphStore.toJSON(clearance) returns) rather than reaching into the store
 * itself. That is deliberate: centrality computed over nodes the caller
 * cannot see would leak their existence through the scores of the nodes they
 * can see - a classic inference channel. Metrics are therefore always
 * relative to the requester's own view of the world, and two analysts at
 * different clearances will legitimately see different numbers.
 *
 * The graph is treated as undirected for reachability and centrality. An
 * affiliation is a connection whichever way the edge was written, and
 * direction is preserved in the data for anyone who needs it.
 */

export interface DegreeEntry {
  id: string;
  label: string;
  degree: number;
  inDegree: number;
  outDegree: number;
}

export interface CentralityEntry {
  id: string;
  label: string;
  /** Normalised to [0,1] against the maximum in this snapshot. */
  score: number;
  raw: number;
}

export interface Component {
  /** Node ids, largest component first when returned from components(). */
  members: string[];
  size: number;
}

export interface Adjacency {
  neighbors: Map<string, Set<string>>;
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
}

/** Builds an undirected adjacency index, keeping directed degree counts. */
export function buildAdjacency(nodes: GraphNode[], edges: GraphEdge[]): Adjacency {
  const neighbors = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const node of nodes) {
    neighbors.set(node.id, new Set());
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
  }

  for (const edge of edges) {
    // An edge to a node outside the snapshot is not a relation this caller can
    // see; skipping it keeps every metric consistent with the visible graph.
    if (!neighbors.has(edge.source) || !neighbors.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  return { neighbors, inDegree, outDegree };
}

export function degrees(nodes: GraphNode[], edges: GraphEdge[]): DegreeEntry[] {
  const { neighbors, inDegree, outDegree } = buildAdjacency(nodes, edges);
  return nodes
    .map((node) => ({
      id: node.id,
      label: node.label,
      degree: neighbors.get(node.id)?.size ?? 0,
      inDegree: inDegree.get(node.id) ?? 0,
      outDegree: outDegree.get(node.id) ?? 0,
    }))
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
}

/**
 * Betweenness centrality via Brandes' algorithm (unweighted, O(V*E)).
 *
 * This is the metric that actually matters for the fraud and affiliation
 * questions this platform is built for: it finds the broker, the entity that
 * sits on the paths between otherwise separate clusters. A shell company
 * linking two networks scores high here while its degree stays low, which is
 * exactly the case a degree ranking misses.
 */
export function betweenness(nodes: GraphNode[], edges: GraphEdge[]): CentralityEntry[] {
  const { neighbors } = buildAdjacency(nodes, edges);
  const ids = nodes.map((n) => n.id);
  const score = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const source of ids) {
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]));
    const sigma = new Map<string, number>(ids.map((id) => [id, 0]));
    const distance = new Map<string, number>(ids.map((id) => [id, -1]));

    sigma.set(source, 1);
    distance.set(source, 0);

    const queue: string[] = [source];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      stack.push(v);
      for (const w of neighbors.get(v) ?? []) {
        if (distance.get(w) === -1) {
          distance.set(w, distance.get(v)! + 1);
          queue.push(w);
        }
        // Accumulate only along shortest paths.
        if (distance.get(w) === distance.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          predecessors.get(w)!.push(v);
        }
      }
    }

    const delta = new Map<string, number>(ids.map((id) => [id, 0]));
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of predecessors.get(w)!) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!));
      }
      if (w !== source) score.set(w, score.get(w)! + delta.get(w)!);
    }
  }

  // Each unordered pair is counted twice on an undirected graph.
  const labels = new Map(nodes.map((n) => [n.id, n.label]));
  const raw = ids.map((id) => ({ id, label: labels.get(id) ?? id, raw: score.get(id)! / 2 }));
  const max = Math.max(0, ...raw.map((r) => r.raw));

  return raw
    .map((r) => ({ ...r, score: max > 0 ? r.raw / max : 0 }))
    .sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id));
}

/** Connected components, largest first. */
export function components(nodes: GraphNode[], edges: GraphEdge[]): Component[] {
  const { neighbors } = buildAdjacency(nodes, edges);
  const seen = new Set<string>();
  const found: Component[] = [];

  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const members: string[] = [];
    const queue = [node.id];
    seen.add(node.id);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      members.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    found.push({ members, size: members.length });
  }

  return found.sort((a, b) => b.size - a.size);
}

/**
 * Edges whose removal would split a component ("bridges", via the standard
 * DFS low-link method). In an affiliation graph a bridge is the single
 * relationship holding two groups together - the link worth verifying first,
 * because if it is wrong the whole inferred connection collapses.
 */
export function bridges(nodes: GraphNode[], edges: GraphEdge[]): { source: string; target: string }[] {
  const { neighbors } = buildAdjacency(nodes, edges);
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const found: { source: string; target: string }[] = [];
  let timer = 0;

  // Iterative DFS: a recursive one would blow the stack on a large graph, and
  // "large" here is a perfectly ordinary ingestion.
  for (const start of nodes.map((n) => n.id)) {
    if (discovery.has(start)) continue;
    parent.set(start, null);
    const stack: { node: string; iterator: Iterator<string> }[] = [
      { node: start, iterator: (neighbors.get(start) ?? new Set()).values() },
    ];
    discovery.set(start, timer);
    low.set(start, timer);
    timer++;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame.iterator.next();

      if (next.done) {
        stack.pop();
        const p = parent.get(frame.node);
        if (p != null) {
          low.set(p, Math.min(low.get(p)!, low.get(frame.node)!));
          if (low.get(frame.node)! > discovery.get(p)!) {
            found.push({ source: p, target: frame.node });
          }
        }
        continue;
      }

      const child = next.value;
      if (child === parent.get(frame.node)) continue;
      if (discovery.has(child)) {
        low.set(frame.node, Math.min(low.get(frame.node)!, discovery.get(child)!));
        continue;
      }

      parent.set(child, frame.node);
      discovery.set(child, timer);
      low.set(child, timer);
      timer++;
      stack.push({ node: child, iterator: (neighbors.get(child) ?? new Set()).values() });
    }
  }

  return found;
}

/**
 * All shortest paths between two entities, not just one. When an analyst asks
 * "how are these two connected", a single path invites the conclusion that it
 * is *the* connection; showing every equally-short route makes the real shape
 * of the link visible.
 */
export function allShortestPaths(
  nodes: GraphNode[],
  edges: GraphEdge[],
  fromId: string,
  toId: string,
  maxPaths = 10,
): string[][] {
  const { neighbors } = buildAdjacency(nodes, edges);
  if (!neighbors.has(fromId) || !neighbors.has(toId)) return [];
  if (fromId === toId) return [[fromId]];

  const distance = new Map<string, number>([[fromId, 0]]);
  const predecessors = new Map<string, string[]>();
  const queue = [fromId];
  let head = 0;

  while (head < queue.length) {
    const v = queue[head++];
    for (const w of neighbors.get(v) ?? []) {
      if (!distance.has(w)) {
        distance.set(w, distance.get(v)! + 1);
        predecessors.set(w, [v]);
        queue.push(w);
      } else if (distance.get(w) === distance.get(v)! + 1) {
        predecessors.get(w)!.push(v);
      }
    }
  }

  if (!distance.has(toId)) return [];

  const paths: string[][] = [];
  const walk = (node: string, suffix: string[]) => {
    if (paths.length >= maxPaths) return;
    if (node === fromId) {
      paths.push([fromId, ...suffix]);
      return;
    }
    for (const p of predecessors.get(node) ?? []) {
      walk(p, [node, ...suffix]);
      if (paths.length >= maxPaths) return;
    }
  };
  walk(toId, []);

  return paths;
}
