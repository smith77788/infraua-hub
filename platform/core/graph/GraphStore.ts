import * as fs from 'fs';
import * as path from 'path';
import { ClearanceLevel } from '../security/Clearance';
import { asViewer, canRead, mergeCompartments, ViewerInput } from '../security/Marking';
import { GraphEdge, GraphNode, NodeType } from './types';
import { OntologyManifest } from './OntologyManifest';

export interface PathResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * In-memory knowledge graph with JSON persistence, following the
 * schema in docs/analyst-architecture.md. This deliberately is not a
 * Neo4j/FalkorDB wrapper for the MVP - a real graph database is a drop
 * in swap later (same reasoning as FileTaskRepository vs Postgres in
 * the software-factory core: no infra needed to run or test this yet).
 *
 * Every read method takes the caller's view - a clearance level, or a
 * level plus the compartments they are read into (core/security/
 * Marking.ts) - and filters nodes/edges they cannot see out *before*
 * traversal, not after. So a restricted fact can never leak by being
 * reachable through an intermediate node the caller isn't allowed to
 * see either, and that holds for need-to-know exactly as it does for
 * the hierarchical level.
 */
export class GraphStore {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private deferPersist = false;

  constructor(private readonly filePath?: string, private readonly ontology?: OntologyManifest) {
    if (filePath && fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const n of data.nodes ?? []) this.nodes.set(n.id, n);
      this.edges = data.edges ?? [];
    }
  }

  private persist(): void {
    if (!this.filePath || this.deferPersist) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ nodes: Array.from(this.nodes.values()), edges: this.edges }, null, 2),
      'utf-8'
    );
  }

  /**
   * Runs `fn`, suppressing the full-JSON rewrite that upsertNode/
   * upsertEdge would otherwise trigger on every single call, then
   * persists once at the end. Without this, a bulk caller (e.g.
   * StructuredRecordConnector ingesting thousands of CSV rows) would
   * rewrite the entire growing graph to disk on every row's node/edge -
   * O(n^2) I/O for n writes instead of O(n).
   */
  runBatch(fn: () => void): void {
    const wasDeferring = this.deferPersist;
    this.deferPersist = true;
    try {
      fn();
    } finally {
      this.deferPersist = wasDeferring;
      this.persist();
    }
  }

  upsertNode(input: {
    id: string;
    type: NodeType;
    label: string;
    properties?: Record<string, unknown>;
    clearance?: ClearanceLevel;
    compartments?: readonly string[];
    sourceDocId?: string;
  }): GraphNode {
    const existing = this.nodes.get(input.id);
    const compartments = mergeCompartments(existing?.compartments, input.compartments);
    const node: GraphNode = {
      id: input.id,
      type: input.type,
      label: input.label,
      properties: { ...(existing?.properties ?? {}), ...(input.properties ?? {}) },
      clearance: input.clearance ?? existing?.clearance ?? ClearanceLevel.PUBLIC,
      ...(compartments.length > 0 ? { compartments } : {}),
      source_doc_ids: Array.from(
        new Set([...(existing?.source_doc_ids ?? []), ...(input.sourceDocId ? [input.sourceDocId] : [])])
      ),
    };
    this.nodes.set(node.id, node);
    this.persist();
    return node;
  }

  upsertEdge(input: {
    source: string;
    target: string;
    relation: string;
    properties?: Record<string, unknown>;
    clearance?: ClearanceLevel;
    compartments?: readonly string[];
    sourceDocId?: string;
  }): GraphEdge {
    const sourceNode = this.nodes.get(input.source);
    const targetNode = this.nodes.get(input.target);
    if (!sourceNode || !targetNode) {
      throw new Error(`Cannot add edge: unknown node(s) ${input.source} -> ${input.target}`);
    }
    if (this.ontology) {
      const validation = this.ontology.validateEdge(input.relation, sourceNode.type, targetNode.type);
      if (!validation.valid) {
        throw new Error(`Rejected by ontology manifest: ${validation.reason}`);
      }
    }
    const existingIdx = this.edges.findIndex(
      (e) => e.source === input.source && e.target === input.target && e.relation === input.relation
    );
    const existing = existingIdx >= 0 ? this.edges[existingIdx] : undefined;
    const edgeCompartments = mergeCompartments(existing?.compartments, input.compartments);
    const edge: GraphEdge = {
      source: input.source,
      target: input.target,
      relation: input.relation,
      properties: { ...(existing?.properties ?? {}), ...(input.properties ?? {}) },
      clearance: input.clearance ?? existing?.clearance ?? ClearanceLevel.PUBLIC,
      ...(edgeCompartments.length > 0 ? { compartments: edgeCompartments } : {}),
      source_doc_ids: Array.from(
        new Set([...(existing?.source_doc_ids ?? []), ...(input.sourceDocId ? [input.sourceDocId] : [])])
      ),
    };
    if (existingIdx >= 0) this.edges[existingIdx] = edge;
    else this.edges.push(edge);
    this.persist();
    return edge;
  }

  /**
   * Retracts everything that came from one ingestion source.
   *
   * A store that can only ever grow is not a store you can operate. Data
   * arrives wrong - a bad mapping, a test run against production, a feed that
   * turns out to be someone else's - and without a way to take a batch back
   * out, the only remedy is deleting the whole graph.
   *
   * Scoped by source document prefix rather than "delete all": retracting a
   * batch is a normal operation, wiping the graph is not, and one should not
   * be reachable by fat-fingering the other.
   *
   * A node touched by more than one source keeps its other provenance and
   * stays: it is not this batch's to remove. Only its reference is dropped.
   * Edges go whenever either endpoint goes, because an edge to a node that no
   * longer exists is not a relation, it is a dangling pointer.
   */
  retractSource(sourcePrefix: string): { nodesRemoved: string[]; edgesRemoved: number } {
    if (!sourcePrefix) throw new Error('sourcePrefix is required');

    const matches = (docId: string) => docId === sourcePrefix || docId.startsWith(`${sourcePrefix}#`);
    const removed: string[] = [];

    for (const node of Array.from(this.nodes.values())) {
      const remaining = node.source_doc_ids.filter((d) => !matches(d));
      if (remaining.length === node.source_doc_ids.length) continue;
      if (remaining.length === 0) {
        this.nodes.delete(node.id);
        removed.push(node.id);
      } else {
        node.source_doc_ids = remaining;
      }
    }

    const gone = new Set(removed);
    const before = this.edges.length;
    this.edges = this.edges.filter((e) => {
      if (gone.has(e.source) || gone.has(e.target)) return false;
      const remaining = e.source_doc_ids.filter((d) => !matches(d));
      if (remaining.length === e.source_doc_ids.length) return true;
      if (remaining.length === 0) return false;
      e.source_doc_ids = remaining;
      return true;
    });

    this.persist();
    return { nodesRemoved: removed, edgesRemoved: before - this.edges.length };
  }

  getNode(id: string, who: ViewerInput = ClearanceLevel.TOP_SECRET): GraphNode | null {
    const node = this.nodes.get(id);
    if (!node || !canRead(who, node)) return null;
    return node;
  }

  findByType(type: NodeType, who: ViewerInput = ClearanceLevel.TOP_SECRET): GraphNode[] {
    const v = asViewer(who);
    return Array.from(this.nodes.values()).filter((n) => n.type === type && canRead(v, n));
  }

  findByLabelContains(text: string, who: ViewerInput = ClearanceLevel.TOP_SECRET): GraphNode[] {
    const needle = text.toLowerCase();
    const v = asViewer(who);
    return Array.from(this.nodes.values()).filter((n) => canRead(v, n) && n.label.toLowerCase().includes(needle));
  }

  neighbors(nodeId: string, who: ViewerInput = ClearanceLevel.TOP_SECRET): { node: GraphNode; edge: GraphEdge }[] {
    const v = asViewer(who);
    const results: { node: GraphNode; edge: GraphEdge }[] = [];
    for (const edge of this.edges) {
      if (!canRead(v, edge)) continue;
      let otherId: string | null = null;
      if (edge.source === nodeId) otherId = edge.target;
      else if (edge.target === nodeId) otherId = edge.source;
      if (!otherId) continue;
      const other = this.getNode(otherId, v);
      if (other) results.push({ node: other, edge });
    }
    return results;
  }

  /** Breadth-first shortest path, visible-subgraph only (clearance-filtered). */
  shortestPath(fromId: string, toId: string, who: ViewerInput = ClearanceLevel.TOP_SECRET): PathResult | null {
    const clearance = asViewer(who);
    if (!this.getNode(fromId, clearance) || !this.getNode(toId, clearance)) return null;
    if (fromId === toId) return { nodes: [this.getNode(fromId, clearance)!], edges: [] };

    const visited = new Set<string>([fromId]);
    const queue: string[] = [fromId];
    const cameFrom = new Map<string, { prev: string; edge: GraphEdge }>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const { node, edge } of this.neighbors(current, clearance)) {
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        cameFrom.set(node.id, { prev: current, edge });
        if (node.id === toId) {
          return this.reconstructPath(fromId, toId, cameFrom, clearance);
        }
        queue.push(node.id);
      }
    }
    return null;
  }

  private reconstructPath(
    fromId: string,
    toId: string,
    cameFrom: Map<string, { prev: string; edge: GraphEdge }>,
    clearance: ViewerInput
  ): PathResult {
    const nodes: GraphNode[] = [this.getNode(toId, clearance)!];
    const edges: GraphEdge[] = [];
    let cur = toId;
    while (cur !== fromId) {
      const step = cameFrom.get(cur)!;
      edges.unshift(step.edge);
      nodes.unshift(this.getNode(step.prev, clearance)!);
      cur = step.prev;
    }
    return { nodes, edges };
  }

  /** Neighbors up to `depth` hops, deduplicated - used to build an investigation's local subgraph. */
  expand(nodeId: string, depth: number, who: ViewerInput = ClearanceLevel.TOP_SECRET): PathResult {
    const clearance = asViewer(who);
    const visitedNodes = new Map<string, GraphNode>();
    const visitedEdgeKeys = new Set<string>();
    const edges: GraphEdge[] = [];
    let frontier = [nodeId];
    const start = this.getNode(nodeId, clearance);
    if (start) visitedNodes.set(start.id, start);

    for (let d = 0; d < depth; d++) {
      const nextFrontier: string[] = [];
      for (const id of frontier) {
        for (const { node, edge } of this.neighbors(id, clearance)) {
          const key = `${edge.source}->${edge.target}:${edge.relation}`;
          if (!visitedEdgeKeys.has(key)) {
            visitedEdgeKeys.add(key);
            edges.push(edge);
          }
          if (!visitedNodes.has(node.id)) {
            visitedNodes.set(node.id, node);
            nextFrontier.push(node.id);
          }
        }
      }
      frontier = nextFrontier;
    }
    return { nodes: Array.from(visitedNodes.values()), edges };
  }

  toJSON(who: ViewerInput = ClearanceLevel.TOP_SECRET): PathResult {
    const v = asViewer(who);
    // Edges are filtered on their own marking *and* on both endpoints: an edge
    // the caller may read between two nodes they may not is a relation with no
    // visible ends, and reporting it would disclose that the ends exist.
    const nodes = Array.from(this.nodes.values()).filter((n) => canRead(v, n));
    const visible = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      edges: this.edges.filter((e) => canRead(v, e) && visible.has(e.source) && visible.has(e.target)),
    };
  }
}
