/**
 * Wire types for the Sovereign Analyst platform API
 * (apps/platform/api/server.ts). These mirror the server's own types in
 * core/graph/types.ts and agents/analyst/InvestigatorAgent.ts — the two live
 * in separate TypeScript projects (the console is ESM/DOM, the server is
 * CommonJS/node), so they are restated here rather than imported across the
 * boundary. Anything added on the server must be added here too; the
 * console's tests pin the shapes that matter.
 */

export enum ClearanceLevel {
  PUBLIC = 0,
  INTERNAL = 1,
  CONFIDENTIAL = 2,
  SECRET = 3,
  TOP_SECRET = 4,
}

export const CLEARANCE_NAMES: Record<ClearanceLevel, string> = {
  [ClearanceLevel.PUBLIC]: "PUBLIC",
  [ClearanceLevel.INTERNAL]: "INTERNAL",
  [ClearanceLevel.CONFIDENTIAL]: "CONFIDENTIAL",
  [ClearanceLevel.SECRET]: "SECRET",
  [ClearanceLevel.TOP_SECRET]: "TOP_SECRET",
};

export const CLEARANCE_ORDER: ClearanceLevel[] = [
  ClearanceLevel.PUBLIC,
  ClearanceLevel.INTERNAL,
  ClearanceLevel.CONFIDENTIAL,
  ClearanceLevel.SECRET,
  ClearanceLevel.TOP_SECRET,
];

export type NodeType = "Person" | "Organization" | "Asset" | "Location" | "Event";

export const NODE_TYPES: NodeType[] = ["Person", "Organization", "Asset", "Location", "Event"];

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  clearance: ClearanceLevel;
  source_doc_ids: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  properties: Record<string, unknown>;
  clearance: ClearanceLevel;
  source_doc_ids: string[];
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PlanStep {
  step: number;
  action:
    | "semantic_search"
    | "resolve_anchors"
    | "expand_graph"
    | "execute_code"
    | "synthesize_narrative";
  detail: string;
}

export interface DocumentHit {
  source: string;
  sector: string;
  score: number;
  excerpt: string;
}

export interface InvestigationResult {
  query: string;
  summary: string;
  narrativeSource: string;
  blocked: boolean;
  plan: PlanStep[];
  documentHits: DocumentHit[];
  subgraph: GraphSnapshot;
  computation: { description: string; result: unknown } | null;
  auditSeq: number;
}

export interface RejectedEdge {
  edge: string;
  reason: string;
}

export interface IngestResult {
  documentId: string;
  nodesCreated: string[];
  edgesCreated: string[];
  /** Relations the ontology refused — surfaced, never silently dropped. */
  edgesRejected: RejectedEdge[];
}

export interface StructuredIngestResult {
  documentIds: string[];
  nodesCreated: string[];
  edgesCreated: string[];
  edgesRejected: RejectedEdge[];
  rowsProcessed: number;
}

export interface AuditEntry {
  seq: number;
  timestamp: string;
  actor: string;
  action: string;
  details: unknown;
  prev_hash: string;
  hash: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  verification: { valid: boolean; brokenAtSeq: number | null };
}

export interface HealthResponse {
  status: string;
  documents: number;
  nodes: number;
  narrative_engine: string;
}

export interface SessionResponse {
  clearance: ClearanceLevel;
  clearanceName: string;
}

export interface EntityFieldMapping {
  type: NodeType;
  idField: string;
  labelField?: string;
  properties?: string[];
}

export interface EdgeFieldMapping {
  relation: string;
  fromField: string;
  toField: string;
  properties?: string[];
}

export interface StructuredMapping {
  entities: EntityFieldMapping[];
  edges: EdgeFieldMapping[];
}

export interface FiredSignal {
  id: string;
  label: string;
  contribution: number;
  reason: string;
  evidence: string;
}

export type RiskBand = "low" | "elevated" | "high" | "severe";

export interface RiskAssessment {
  id: string;
  label: string;
  type: string;
  score: number;
  band: RiskBand;
  signals: FiredSignal[];
}

export interface CentralityEntry {
  id: string;
  label: string;
  score: number;
  raw: number;
}

export interface DegreeEntry {
  id: string;
  label: string;
  degree: number;
  inDegree: number;
  outDegree: number;
}

export interface DuplicateCandidate {
  a: { id: string; label: string; type: string };
  b: { id: string; label: string; type: string };
  confidence: number;
  reasons: string[];
  sharedNeighbors: string[];
}

export interface AnalyticsResponse {
  totals: {
    nodes: number;
    edges: number;
    components: number;
    largestComponent: number;
    isolated: number;
  };
  risk: RiskAssessment[];
  riskBands: Record<RiskBand, number>;
  centrality: CentralityEntry[];
  connectivity: DegreeEntry[];
  duplicateCandidates: DuplicateCandidate[];
}

export interface PathsResponse {
  from: string;
  to: string;
  connected: boolean;
  hops: number | null;
  paths: { id: string; label: string; type?: NodeType }[][];
}

export interface CaseFinding {
  auditSeq: number;
  query: string;
  summary: string;
  narrativeSource: string;
  entityIds: string[];
  clearance: ClearanceLevel;
  attachedAt: string;
}

export interface CaseNote {
  text: string;
  authorKeyId: string;
  createdAt: string;
}

export interface AnalystCase {
  id: string;
  title: string;
  clearance: ClearanceLevel;
  createdAt: string;
  updatedAt: string;
  createdByKeyId: string;
  findings: CaseFinding[];
  notes: CaseNote[];
  pinnedEntityIds: string[];
}

export interface AttachFindingResponse {
  case: AnalystCase;
  investigation: InvestigationResult;
  /** True when attaching this finding narrowed who can read the case. */
  clearanceRaised: boolean;
  previousClearance: ClearanceLevel;
}
