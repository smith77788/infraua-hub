import { ClearanceLevel } from '../security/Clearance';

/**
 * Node/edge types follow the 5-entity ontology from the design docs:
 * Person, Organization, Asset, Location, Event connected by directed,
 * typed relations. Kept fixed for the MVP (not LLM-extended at
 * runtime) - see docs/analyst-architecture.md "Ontology".
 */
export type NodeType = 'Person' | 'Organization' | 'Asset' | 'Location' | 'Event';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  clearance: ClearanceLevel;
  /**
   * Need-to-know compartments required on top of the level (core/security/
   * Marking.ts). Absent on every record written before compartments existed,
   * which reads correctly as "the level alone decides".
   */
  compartments?: string[];
  source_doc_ids: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  properties: Record<string, unknown>;
  clearance: ClearanceLevel;
  compartments?: string[];
  source_doc_ids: string[];
}
