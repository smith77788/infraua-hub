import { SearchHit } from '../../../core/vector/VectorIndex';
import { GraphEdge, GraphNode } from '../../../core/graph/types';

export interface NarrativeInput {
  query: string;
  hits: SearchHit[];
  subgraphNodeCount: number;
  subgraph: { nodes: GraphNode[]; edges: GraphEdge[] };
  computation: { description: string; result: unknown } | null;
}

/**
 * Backend-agnostic contract for turning verified structured findings
 * into a natural-language answer. Same adapter pattern as
 * agents/coder/CodingAgentAdapter.ts in the AI Software Factory core -
 * the investigator never depends on a concrete provider.
 */
export interface NarrativeAdapter {
  readonly name: string;
  synthesize(input: NarrativeInput): Promise<string>;
}
