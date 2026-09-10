import * as fs from 'fs';
import * as path from 'path';
import { ClearanceLevel } from '../security/Clearance';
import { asViewer, canRead, mergeCompartments, ViewerInput } from '../security/Marking';
import { GraphEdge, GraphNode, NodeType } from './types';
import { OntologyManifest } from './OntologyManifest';
import { Revision, RevisionLog } from './RevisionLog';

export interface PathResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Carries valid time forward across an upsert.
 *
 * A later assertion that says nothing about validity must not erase what an
 * earlier one knew - the same rule as compartments, for the same reason: the
 * most routine operation in the system should not be able to quietly drop a
 * fact nobody re-stated.
 *
 * Passing an empty string *does* clear a bound, and that is the only way to.
 * A repaired substation needs its `valid_to` gone rather than moved: leaving
 * an open-ended damage interval behind would hide the node from every
 * `validAt` query after the repair.
 */
function validityOf(
  input: { validFrom?: string; validTo?: string },
  existing?: { valid_from?: string; valid_to?: string },
): { valid_from?: string; valid_to?: string } {
  const validFrom = input.validFrom ?? existing?.valid_from;
  const validTo = input.validTo ?? existing?.valid_to;
  return {
    ...(validFrom ? { valid_from: validFrom } : {}),
    ...(validTo ? { valid_to: validTo } : {}),
  };
}

/**
 * Rebuilds a state from a slice of the journal.
 *
 * A retraction is replayed as a retraction rather than skipped: the point of
 * reconstructing the 14th is to see what the analyst saw, and if a batch had
 * already been withdrawn by then, it was not in front of them.
 */
function replay(revisions: Revision[]): { nodes: Map<string, GraphNode>; edges: GraphEdge[]; replayed: number } {
  const nodes = new Map<string, GraphNode>();
  let edges: GraphEdge[] = [];

  for (const revision of revisions) {
    if (revision.op === 'upsert_node') {
      const node = revision.payload as GraphNode;
      nodes.set(node.id, node);
    } else if (revision.op === 'upsert_edge') {
      const edge = revision.payload as GraphEdge;
      const index = edges.findIndex(
        (e) => e.source === edge.source && e.target === edge.target && e.relation === edge.relation,
      );
      if (index >= 0) edges[index] = edge;
      else edges.push(edge);
    } else {
      const { source } = revision.payload as { source: string };
      const matches = (docId: string) => docId === source || docId.startsWith(`${source}#`);
      const gone = new Set<string>();
      for (const node of Array.from(nodes.values())) {
        const remaining = node.source_doc_ids.filter((d) => !matches(d));
        if (remaining.length === node.source_doc_ids.length) continue;
        if (remaining.length === 0) {
          nodes.delete(node.id);
          gone.add(node.id);
        } else {
          nodes.set(node.id, { ...node, source_doc_ids: remaining });
        }
      }
      edges = edges.filter((e) => {
        if (gone.has(e.source) || gone.has(e.target)) return false;
        const remaining = e.source_doc_ids.filter((d) => !matches(d));
        return remaining.length > 0;
      });
    }
  }

  return { nodes, edges, replayed: revisions.length };
}

/** Fields that differ between two versions of a node, named rather than counted. */
function changedFields(before: GraphNode, after: GraphNode): string[] {
  const fields: string[] = [];
  if (before.label !== after.label) fields.push('label');
  if (before.clearance !== after.clearance) fields.push('clearance');
  if ((before.compartments ?? []).join(',') !== (after.compartments ?? []).join(',')) fields.push('compartments');
  if (before.valid_from !== after.valid_from) fields.push('valid_from');
  if (before.valid_to !== after.valid_to) fields.push('valid_to');

  const keys = new Set([...Object.keys(before.properties), ...Object.keys(after.properties)]);
  for (const key of keys) {
    if (JSON.stringify(before.properties[key]) !== JSON.stringify(after.properties[key])) {
      fields.push(`properties.${key}`);
    }
  }
  return fields;
}

/** True when the record's own validity interval contains `instant`. */
export function validAt(record: { valid_from?: string; valid_to?: string }, instant: string): boolean {
  if (record.valid_from && instant < record.valid_from) return false;
  // Half-open interval: a fact valid "to" a moment is not valid at it. Closed
  // intervals make consecutive states overlap for one instant, and every
  // aggregate over the boundary then double-counts.
  if (record.valid_to && instant >= record.valid_to) return false;
  return true;
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
  private readonly revisions?: RevisionLog;

  constructor(
    private readonly filePath?: string,
    private readonly ontology?: OntologyManifest,
    revisions?: RevisionLog,
  ) {
    this.revisions = revisions;
    if (filePath && fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const n of data.nodes ?? []) this.nodes.set(n.id, n);
      this.edges = data.edges ?? [];
    }
  }

  /** Null when this store keeps no history. */
  history(): RevisionLog | undefined {
    return this.revisions;
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
    validFrom?: string;
    validTo?: string;
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
      ...validityOf(input, existing),
      source_doc_ids: Array.from(
        new Set([...(existing?.source_doc_ids ?? []), ...(input.sourceDocId ? [input.sourceDocId] : [])])
      ),
    };
    this.nodes.set(node.id, node);
    this.revisions?.append('upsert_node', node);
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
    validFrom?: string;
    validTo?: string;
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
      ...validityOf(input, existing),
      source_doc_ids: Array.from(
        new Set([...(existing?.source_doc_ids ?? []), ...(input.sourceDocId ? [input.sourceDocId] : [])])
      ),
    };
    if (existingIdx >= 0) this.edges[existingIdx] = edge;
    else this.edges.push(edge);
    this.revisions?.append('upsert_edge', edge);
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

    this.revisions?.append('retract_source', { source: sourcePrefix });
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

  /**
   * The graph as it stood at a past instant, on either time axis or both.
   *
   * `asOf` is transaction time - the journal is replayed to that point, so the
   * answer is what the platform *knew* then, not what it now knows about then.
   * `validAt` is world time, filtering on each record's own validity interval.
   * They compose: "what did we believe on the 9th about how the grid stood on
   * the 3rd" is a question with an answer, and it is a different answer from
   * either axis alone.
   *
   * Clearance is applied to the reconstructed state, never to the journal:
   * markings are part of a record and travel with it through replay, so a
   * fact classified today was classified in the reconstruction too.
   */
  asOf(
    options: { asOf?: string; asOfSeq?: number; validAt?: string },
    who: ViewerInput = ClearanceLevel.TOP_SECRET,
  ): PathResult & {
    basis: { asOf: string | null; asOfSeq: number | null; validAt: string | null; revisionsReplayed: number };
  } {
    const v = asViewer(who);

    let nodes: GraphNode[];
    let edges: GraphEdge[];
    let replayed = 0;

    if (options.asOf !== undefined || options.asOfSeq !== undefined) {
      if (!this.revisions) {
        throw new Error('This graph keeps no revision history, so a past state cannot be reconstructed.');
      }
      // A sequence wins over a timestamp when both are given: it is the exact
      // cursor, and the timestamp is at best the millisecond containing it.
      const slice =
        options.asOfSeq !== undefined
          ? this.revisions.upToSeq(options.asOfSeq)
          : this.revisions.upTo(options.asOf!);
      const state = replay(slice);
      replayed = state.replayed;
      nodes = Array.from(state.nodes.values());
      edges = state.edges;
    } else {
      nodes = Array.from(this.nodes.values());
      edges = this.edges;
    }

    let visibleNodes = nodes.filter((n) => canRead(v, n));
    let visibleEdges = edges.filter((e) => canRead(v, e));

    if (options.validAt) {
      const instant = options.validAt;
      visibleNodes = visibleNodes.filter((n) => validAt(n, instant));
      visibleEdges = visibleEdges.filter((e) => validAt(e, instant));
    }

    const present = new Set(visibleNodes.map((n) => n.id));
    return {
      nodes: visibleNodes,
      edges: visibleEdges.filter((e) => present.has(e.source) && present.has(e.target)),
      basis: {
        asOf: options.asOf ?? null,
        asOfSeq: options.asOfSeq ?? null,
        validAt: options.validAt ?? null,
        revisionsReplayed: replayed,
      },
    };
  }

  /**
   * What changed between two instants of transaction time.
   *
   * Reported as three lists rather than a patch: an analyst opening this wants
   * "what appeared, what went, what moved", and a diff format optimised for
   * applying changes is the wrong shape for reading them.
   */
  diff(
    from: string | number,
    to: string | number,
    who: ViewerInput = ClearanceLevel.TOP_SECRET,
  ): {
    added: { nodes: GraphNode[]; edges: GraphEdge[] };
    removed: { nodes: GraphNode[]; edges: GraphEdge[] };
    changed: { id: string; label: string; fields: string[] }[];
  } {
    const cursor = (value: string | number) =>
      typeof value === 'number' ? { asOfSeq: value } : { asOf: value };
    const before = this.asOf(cursor(from), who);
    const after = this.asOf(cursor(to), who);

    const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
    const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
    const edgeKey = (e: GraphEdge) => `${e.source}->${e.target}:${e.relation}`;
    const beforeEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
    const afterEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));

    const changed: { id: string; label: string; fields: string[] }[] = [];
    for (const [id, node] of afterNodes) {
      const was = beforeNodes.get(id);
      if (!was) continue;
      const fields = changedFields(was, node);
      if (fields.length > 0) changed.push({ id, label: node.label, fields });
    }

    return {
      added: {
        nodes: after.nodes.filter((n) => !beforeNodes.has(n.id)),
        edges: after.edges.filter((e) => !beforeEdges.has(edgeKey(e))),
      },
      removed: {
        nodes: before.nodes.filter((n) => !afterNodes.has(n.id)),
        edges: before.edges.filter((e) => !afterEdges.has(edgeKey(e))),
      },
      changed,
    };
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
