import * as fs from 'fs';
import { GraphEdge, GraphNode } from '../graph/types';
import { betweenness, bridges, buildAdjacency } from './GraphMetrics';

/**
 * Explainable risk scoring.
 *
 * The rule this file exists to enforce: **a score is never a bare number.**
 * Every point comes from a named signal with a stated reason and the evidence
 * that triggered it, so an analyst can disagree with a score by pointing at
 * the specific signal they think is wrong. An unexplainable risk number in an
 * intelligence or compliance context is worse than no number at all - it gets
 * acted on without anyone being able to check it, and nobody can tell whether
 * the model is picking up fraud or picking up a proxy for something it should
 * not be considering.
 *
 * Signals live in config/risk_signals.json, not in code, because what counts
 * as risky is a domain judgement the operator makes.
 */

export type SignalType =
  | 'betweenness'
  | 'degree'
  | 'bridge_endpoint'
  | 'relation'
  | 'relation_combination'
  | 'property_sum'
  /**
   * A relation *and* something about it. Holding a contract is not a signal -
   * the state buys things. Holding one awarded without competition, or one
   * above a threshold on its own, is. Flattening that into the plain
   * `relation` type would score every counterparty of every public buyer
   * identically, which is the same as scoring nothing.
   */
  | 'relation_property';

export interface RiskSignalConfig {
  id: string;
  label: string;
  type: SignalType;
  weight: number;
  reason: string;
  threshold?: number;
  relation?: string;
  relations?: string[];
  property?: string;
  /** For `relation_property`: the exact value the property must hold. */
  equals?: string | number | boolean;
  /**
   * For `betweenness`: the minimum *unnormalised* value as well.
   *
   * Normalisation is against the maximum in the snapshot, so on a sparse graph
   * a node lying between exactly one pair scores 1.00 and clears any threshold
   * - it is the maximum because nothing else brokers anything at all.
   * Measured on 100 real procurement records: every hub of a three-node star
   * came out as maximal brokerage. The raw floor is what makes the signal mean
   * "brokers many paths" rather than "brokers the most paths here".
   */
  minRaw?: number;
  /**
   * For `bridge_endpoint`: the minimum number of nodes on the smaller side of
   * the split. Below this the edge is a pendant, not a hinge.
   */
  minSide?: number;
}

export interface FiredSignal {
  id: string;
  label: string;
  /** Points this signal contributed before the total was capped. */
  contribution: number;
  reason: string;
  /** What actually triggered it — the value, the relation, the counterparty. */
  evidence: string;
}

export interface RiskAssessment {
  id: string;
  label: string;
  type: string;
  /** 0-100. Capped, so a long tail of small signals cannot exceed a severe one. */
  score: number;
  band: 'low' | 'elevated' | 'high' | 'severe';
  signals: FiredSignal[];
}

interface SignalContext {
  degree: number;
  /** Normalised against the snapshot maximum — comparable within, not across. */
  betweenness: number;
  /** Shortest paths actually brokered. Not relative, so it means the same everywhere. */
  betweennessRaw: number;
  /** Nodes on the smaller side of the largest split this node's bridges cause; 0 if none. */
  bridgeSide: number;
  edges: GraphEdge[];
  labels: Map<string, string>;
}

function bandFor(score: number): RiskAssessment['band'] {
  if (score >= 70) return 'severe';
  if (score >= 45) return 'high';
  if (score >= 20) return 'elevated';
  return 'low';
}

export class RiskScorer {
  constructor(private readonly signals: RiskSignalConfig[]) {}

  static fromFile(filePath: string): RiskScorer {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { signals?: RiskSignalConfig[] };
    if (!Array.isArray(parsed.signals)) {
      throw new Error(`${filePath}: expected a "signals" array`);
    }
    for (const signal of parsed.signals) {
      if (!signal.id || !signal.type || typeof signal.weight !== 'number') {
        throw new Error(`${filePath}: signal ${signal.id ?? '<unnamed>'} needs an id, a type and a numeric weight`);
      }
    }
    return new RiskScorer(parsed.signals);
  }

  /**
   * Scores every node in an already clearance-filtered snapshot. As with the
   * centrality metrics, scoring only what the caller can see keeps a
   * high-clearance relation from raising a visible entity's score and thereby
   * hinting at the hidden relation's existence.
   */
  score(nodes: GraphNode[], edges: GraphEdge[]): RiskAssessment[] {
    const { neighbors } = buildAdjacency(nodes, edges);
    const centralityEntries = betweenness(nodes, edges);
    const centrality = new Map(centralityEntries.map((c) => [c.id, c.score]));
    const centralityRaw = new Map(centralityEntries.map((c) => [c.id, c.raw]));
    const labels = new Map(nodes.map((n) => [n.id, n.label]));

    // Keyed by the smaller side of the split, so a signal can insist on a
    // bridge that separates something rather than one that trims a leaf.
    const bridgeSideByNode = new Map<string, number>();
    for (const bridge of bridges(nodes, edges)) {
      for (const endpoint of [bridge.source, bridge.target]) {
        bridgeSideByNode.set(endpoint, Math.max(bridgeSideByNode.get(endpoint) ?? 0, bridge.smallerSide));
      }
    }

    const incident = new Map<string, GraphEdge[]>(nodes.map((n) => [n.id, []]));
    for (const edge of edges) {
      incident.get(edge.source)?.push(edge);
      incident.get(edge.target)?.push(edge);
    }

    return nodes
      .map((node) => this.scoreNode(node, {
        degree: neighbors.get(node.id)?.size ?? 0,
        betweenness: centrality.get(node.id) ?? 0,
        betweennessRaw: centralityRaw.get(node.id) ?? 0,
        bridgeSide: bridgeSideByNode.get(node.id) ?? 0,
        edges: incident.get(node.id) ?? [],
        labels,
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }

  private scoreNode(
    node: GraphNode,
    context: SignalContext,
  ): RiskAssessment {
    const fired: FiredSignal[] = [];

    for (const signal of this.signals) {
      const hit = this.evaluate(signal, node, context);
      if (hit) fired.push({ id: signal.id, label: signal.label, contribution: signal.weight, reason: signal.reason, evidence: hit });
    }

    const total = fired.reduce((sum, s) => sum + s.contribution, 0);
    const score = Math.min(100, Math.round(total));

    return { id: node.id, label: node.label, type: node.type, score, band: bandFor(score), signals: fired };
  }

  /** Returns the evidence string when the signal fires, or null when it does not. */
  private evaluate(
    signal: RiskSignalConfig,
    node: GraphNode,
    context: SignalContext,
  ): string | null {
    switch (signal.type) {
      case 'betweenness': {
        const threshold = signal.threshold ?? 0.5;
        const minRaw = signal.minRaw ?? 0;
        if (context.betweenness < threshold) return null;
        if (context.betweennessRaw < minRaw) return null;
        return `normalised betweenness ${context.betweenness.toFixed(2)} ≥ ${threshold} (on ${context.betweennessRaw.toFixed(1)} shortest paths)`;
      }

      case 'degree': {
        const threshold = signal.threshold ?? 5;
        if (context.degree < threshold) return null;
        return `${context.degree} relations ≥ ${threshold}`;
      }

      case 'bridge_endpoint': {
        const minSide = signal.minSide ?? 1;
        if (context.bridgeSide < minSide) return null;
        return `removing one relation would cut off ${context.bridgeSide} entit${context.bridgeSide === 1 ? 'y' : 'ies'}`;
      }

      case 'relation': {
        const match = context.edges.find((e) => e.relation === signal.relation);
        if (!match) return null;
        const otherId = match.source === node.id ? match.target : match.source;
        return `${signal.relation} → ${context.labels.get(otherId) ?? otherId}`;
      }

      case 'relation_combination': {
        const required = signal.relations ?? [];
        if (required.length === 0) return null;
        const present = new Set(context.edges.map((e) => e.relation));
        if (!required.every((r) => present.has(r))) return null;
        return `holds all of: ${required.join(', ')}`;
      }

      case 'relation_property': {
        const property = signal.property;
        if (!property || !signal.relation) return null;
        const candidates = context.edges.filter((e) => e.relation === signal.relation);
        if (candidates.length === 0) return null;

        if (signal.equals !== undefined) {
          const match = candidates.find((e) => e.properties[property] === signal.equals);
          if (!match) return null;
          const otherId = match.source === node.id ? match.target : match.source;
          const count = candidates.filter((e) => e.properties[property] === signal.equals).length;
          return `${count} × ${signal.relation} with ${property}=${String(signal.equals)} (e.g. ${context.labels.get(otherId) ?? otherId})`;
        }

        const threshold = signal.threshold ?? 0;
        // The largest single edge, not the sum: `property_sum` already answers
        // the aggregate question, and one large contract is a different
        // pattern from a hundred small ones.
        let largest: { value: number; edge: GraphEdge } | null = null;
        for (const edge of candidates) {
          const value = edge.properties[property];
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          if (value >= threshold && (largest === null || value > largest.value)) largest = { value, edge };
        }
        if (!largest) return null;
        const otherId = largest.edge.source === node.id ? largest.edge.target : largest.edge.source;
        return `single ${signal.relation} of ${largest.value.toLocaleString('en-US')} ≥ ${threshold.toLocaleString('en-US')} (${context.labels.get(otherId) ?? otherId})`;
      }

      case 'property_sum': {
        const property = signal.property;
        const threshold = signal.threshold ?? 0;
        if (!property) return null;
        const total = context.edges.reduce((sum, e) => {
          const value = e.properties[property];
          return sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        }, 0);
        if (total < threshold) return null;
        return `${property} totals ${total.toLocaleString('en-US')} ≥ ${threshold.toLocaleString('en-US')}`;
      }

      default:
        // An unknown signal type is a config error, but it must not take the
        // whole assessment down - the other signals are still valid.
        return null;
    }
  }
}
