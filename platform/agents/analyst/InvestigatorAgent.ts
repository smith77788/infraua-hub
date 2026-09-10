import * as fs from 'fs';
import * as path from 'path';
import { GraphStore } from '../../core/graph/GraphStore';
import { VectorIndex, SearchHit } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { Executor } from '../../core/execution/Executor';
import { ClearanceLevel } from '../../core/security/Clearance';
import { Guardrails } from '../../core/security/Guardrails';
import { GraphEdge, GraphNode } from '../../core/graph/types';
import { NarrativeAdapter, NarrativeInput } from './narrative/NarrativeAdapter';
import { DeterministicNarrativeAdapter } from './narrative/DeterministicNarrativeAdapter';
import { checkGrounding } from './narrative/GroundingValidator';

export interface PlanStep {
  step: number;
  action: 'semantic_search' | 'resolve_anchors' | 'expand_graph' | 'execute_code' | 'synthesize_narrative';
  detail: string;
}

export interface InvestigationResult {
  query: string;
  summary: string;
  narrativeSource: string;
  blocked: boolean;
  plan: PlanStep[];
  documentHits: { source: string; sector: string; score: number; excerpt: string }[];
  subgraph: { nodes: GraphNode[]; edges: GraphEdge[] };
  computation: { description: string; result: unknown } | null;
  auditSeq: number;
}

/**
 * Splits text into lowercase word tokens. Whole tokens only: matching on
 * substrings is what let "corporate" match an entity named "Acme Corp".
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const AGGREGATE_CUES = /сумм|итог|total|amount|ущерб|стоимост/i;
const DELAY_CUES = /задержк|простой|delay/i;
const DISTANCE_CUES = /расстояни|дистанц|distance/i;

/**
 * Answers a natural-language investigation query by combining
 * semantic search (VectorIndex) with graph traversal (GraphStore),
 * and - critically - never computes a sum, delay total, or distance
 * itself. Any numeric aggregation is written out as a small script and
 * executed for real inside the sandboxed Executor, exactly the
 * anti-hallucination principle repeated across every uploaded design
 * doc ("the model must never do the arithmetic in its head"). Every
 * call is recorded to the AuditLog so the full
 * query -> hits -> subgraph -> code -> number chain is replayable.
 */
export class InvestigatorAgent {
  private readonly fallbackNarrator = new DeterministicNarrativeAdapter();

  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorIndex,
    private readonly audit: AuditLog,
    private readonly sandboxDir: string,
    private readonly guardrails?: Guardrails,
    private readonly narrator: NarrativeAdapter = new DeterministicNarrativeAdapter()
  ) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  async investigate(query: string, clearance: ClearanceLevel): Promise<InvestigationResult> {
    const guardCheck = this.guardrails?.validateQuery(query);
    if (guardCheck && !guardCheck.allowed) {
      const entry = this.audit.append('investigator-agent', 'query_blocked', { query, clearance, reason: guardCheck.reason });
      return {
        query,
        summary: `Query blocked by input guardrails: ${guardCheck.reason}`,
        narrativeSource: 'guardrails',
        blocked: true,
        plan: [],
        documentHits: [],
        subgraph: { nodes: [], edges: [] },
        computation: null,
        auditSeq: entry.seq,
      };
    }

    const plan: PlanStep[] = [];
    let step = 1;

    plan.push({ step: step++, action: 'semantic_search', detail: `Search the vector index for documents relevant to: "${query}"` });
    const hits = this.vectors.search(query, clearance, 5);

    plan.push({ step: step++, action: 'resolve_anchors', detail: 'Find graph entities whose label is mentioned in the query' });
    const anchors = this.findAnchorNodes(query, clearance);

    plan.push({ step: step++, action: 'expand_graph', detail: `Expand 2 hops from ${anchors.length} anchor entit${anchors.length === 1 ? 'y' : 'ies'}` });
    const subgraphNodes = new Map<string, GraphNode>();
    const subgraphEdges: GraphEdge[] = [];
    for (const anchor of anchors) {
      const expansion = this.graph.expand(anchor.id, 2, clearance);
      for (const n of expansion.nodes) subgraphNodes.set(n.id, n);
      for (const e of expansion.edges) subgraphEdges.push(e);
    }

    let computation: InvestigationResult['computation'] = null;
    if (AGGREGATE_CUES.test(query)) {
      plan.push({ step: step++, action: 'execute_code', detail: 'Sum tracked monetary amounts on the expanded subgraph via sandboxed code execution' });
      computation = await this.computeAmountTotal(subgraphEdges);
    } else if (DELAY_CUES.test(query)) {
      plan.push({ step: step++, action: 'execute_code', detail: 'Compute the maximum reported delay via sandboxed code execution' });
      computation = await this.computeDelayTotal(subgraphEdges);
    } else if (DISTANCE_CUES.test(query)) {
      // A distance query rarely names its locations directly ("distance
      // between the depots"), so fall back to every Location the requester
      // can see rather than only the ones reachable from a named anchor.
      const locationCandidates = subgraphNodes.size > 0 ? Array.from(subgraphNodes.values()) : this.graph.findByType('Location', clearance);
      plan.push({ step: step++, action: 'execute_code', detail: 'Compute great-circle distances between known locations via sandboxed code execution' });
      computation = await this.computeDistances(locationCandidates);
    }

    plan.push({ step: step++, action: 'synthesize_narrative', detail: `Generate the final answer via the "${this.narrator.name}" narrative engine` });
    const narrativeInput: NarrativeInput = {
      query,
      hits,
      subgraphNodeCount: subgraphNodes.size,
      subgraph: { nodes: Array.from(subgraphNodes.values()), edges: subgraphEdges },
      computation,
    };
    const { summary, narrativeSource, rejectionReason } = await this.synthesizeNarrative(narrativeInput);

    const entry = this.audit.append('investigator-agent', 'investigate', {
      query,
      clearance,
      plan,
      hitCount: hits.length,
      anchorIds: anchors.map((a) => a.id),
      subgraphSize: { nodes: subgraphNodes.size, edges: subgraphEdges.length },
      computation,
      narrativeSource,
      narrativeRejectionReason: rejectionReason,
    });

    return {
      query,
      summary,
      narrativeSource,
      blocked: false,
      plan,
      documentHits: hits.map((h) => this.toHitSummary(h)),
      subgraph: { nodes: Array.from(subgraphNodes.values()), edges: subgraphEdges },
      computation,
      auditSeq: entry.seq,
    };
  }

  /**
   * Always tries the configured narrator first, but never trusts it
   * blindly: a generative adapter's output must pass checkGrounding()
   * before use, and any error or grounding failure falls back to the
   * deterministic template rather than surfacing a broken or
   * fabricated answer. The deterministic adapter itself skips the
   * grounding check - it is grounded by construction.
   */
  private async synthesizeNarrative(
    input: NarrativeInput
  ): Promise<{ summary: string; narrativeSource: string; rejectionReason?: string }> {
    if (this.narrator.name === this.fallbackNarrator.name) {
      return { summary: await this.narrator.synthesize(input), narrativeSource: this.narrator.name };
    }
    try {
      const candidate = await this.narrator.synthesize(input);
      const grounding = checkGrounding(candidate, input);
      if (grounding.grounded) {
        return { summary: candidate, narrativeSource: this.narrator.name };
      }
      return {
        summary: await this.fallbackNarrator.synthesize(input),
        narrativeSource: this.fallbackNarrator.name,
        rejectionReason: grounding.reason,
      };
    } catch (err) {
      return {
        summary: await this.fallbackNarrator.synthesize(input),
        narrativeSource: this.fallbackNarrator.name,
        rejectionReason: `narrator error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private toHitSummary(hit: SearchHit) {
    return {
      source: hit.document.source,
      sector: hit.document.sector,
      score: Math.round(hit.score * 1000) / 1000,
      excerpt: hit.document.text.slice(0, 240),
    };
  }

  /**
   * Resolves the entities a query is actually about.
   *
   * Matching is on whole tokens weighted by how rare they are across the
   * visible labels, which fixes two failure modes of a plain substring scan:
   *
   * - "corporate fraud" used to anchor every Organization whose label
   *   contains "Corp", because "corp" is a substring of "corporate". Every
   *   one of those became a traversal root, so the subgraph filled with
   *   entities the query never mentioned.
   * - An entity labelled "IBM" or "BAE" could never be anchored at all,
   *   because the old filter dropped tokens of three characters or fewer.
   *
   * Rarity is measured against the graph's own labels rather than a
   * hand-kept stopword list: in a corpus of vendors, "corp" appears in most
   * labels and carries no information, while "acme" appears in one and is a
   * near-certain reference. That falls out of the data and needs no
   * maintenance as the corpus changes.
   */
  private findAnchorNodes(query: string, clearance: ClearanceLevel): GraphNode[] {
    const all = [
      ...this.graph.findByType('Person', clearance),
      ...this.graph.findByType('Organization', clearance),
      ...this.graph.findByType('Asset', clearance),
      ...this.graph.findByType('Location', clearance),
      ...this.graph.findByType('Event', clearance),
    ];
    if (all.length === 0) return [];

    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];

    // Document frequency of each token across the labels this caller can see.
    const documentFrequency = new Map<string, number>();
    const labelTokens = new Map<string, string[]>();
    for (const node of all) {
      const tokens = tokenize(node.label);
      labelTokens.set(node.id, tokens);
      for (const token of new Set(tokens)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }

    // A token is distinctive when it appears in at most a fifth of the visible
    // labels (and always when it appears in only one). The floor of 1 keeps
    // small graphs working, where a fifth rounds to nothing.
    const distinctiveMax = Math.max(1, Math.floor(all.length * 0.2));

    return all.filter((node) => {
      const tokens = labelTokens.get(node.id) ?? [];
      return tokens.some(
        (token) =>
          queryTokens.has(token) && (documentFrequency.get(token) ?? 0) <= distinctiveMax,
      );
    });
  }

  private async runScript(script: string): Promise<unknown> {
    const scriptPath = path.join(this.sandboxDir, `calc-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(scriptPath, script, 'utf-8');
    const executor = new Executor({ workingDir: this.sandboxDir, allowedCommands: ['node'] });
    try {
      const result = await executor.run('node', [path.basename(scriptPath)]);
      if (result.exitCode !== 0) {
        throw new Error(`Calculation script failed: ${result.stderr || result.stdout}`);
      }
      return JSON.parse(result.stdout.trim());
    } finally {
      fs.unlinkSync(scriptPath);
    }
  }

  private async computeAmountTotal(edges: GraphEdge[]): Promise<InvestigationResult['computation']> {
    const amounts = edges.map((e) => e.properties.amount).filter((a): a is number => typeof a === 'number');
    if (amounts.length === 0) return null;
    const script = `const data = ${JSON.stringify(amounts)};\nconsole.log(JSON.stringify({ sum: data.reduce((a, b) => a + b, 0), count: data.length }));`;
    const result = (await this.runScript(script)) as { sum: number; count: number };
    return { description: `Executed code summed ${result.count} tracked amount(s): $${result.sum.toLocaleString()}.`, result };
  }

  private async computeDelayTotal(edges: GraphEdge[]): Promise<InvestigationResult['computation']> {
    const delays = edges.map((e) => e.properties.delay_days).filter((d): d is number => typeof d === 'number');
    if (delays.length === 0) return null;
    const script = `const data = ${JSON.stringify(delays)};\nconsole.log(JSON.stringify({ maxDelayDays: Math.max(...data), count: data.length }));`;
    const result = (await this.runScript(script)) as { maxDelayDays: number; count: number };
    return { description: `Executed code found a maximum reported delay of ${result.maxDelayDays} day(s) across ${result.count} link(s).`, result };
  }

  private async computeDistances(nodes: GraphNode[]): Promise<InvestigationResult['computation']> {
    const withCoords = nodes.filter((n) => typeof n.properties.lat === 'number' && typeof n.properties.lon === 'number');
    if (withCoords.length < 2) return null;
    const points = withCoords.map((n) => ({ id: n.id, lat: n.properties.lat, lon: n.properties.lon }));
    const script = `
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}
const points = ${JSON.stringify(points)};
const pairs = [];
for (let i = 0; i < points.length; i++) {
  for (let j = i + 1; j < points.length; j++) {
    pairs.push({ from: points[i].id, to: points[j].id, km: Math.round(haversineKm(points[i], points[j]) * 100) / 100 });
  }
}
console.log(JSON.stringify({ pairs }));`;
    const result = (await this.runScript(script)) as { pairs: { from: string; to: string; km: number }[] };
    return {
      description: `Executed code computed great-circle distance for ${result.pairs.length} location pair(s).`,
      result,
    };
  }
}
