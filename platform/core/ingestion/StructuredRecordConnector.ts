import { NodeType } from '../graph/types';
import { GraphStore } from '../graph/GraphStore';
import { VectorIndex, IndexedDocument } from '../vector/VectorIndex';
import { AuditLog } from '../audit/AuditLog';
import { ClearanceLevel } from '../security/Clearance';
import { slugify } from './IngestionService';

export interface EntityFieldMapping {
  type: NodeType;
  /** Column whose value becomes (type-namespaced +) the node id. */
  idField: string;
  /** Column used as the node's label; defaults to idField's own value. */
  labelField?: string;
  /** Columns to copy onto the node's properties. */
  properties?: string[];
}

export interface EdgeFieldMapping {
  relation: string;
  /** Must equal some entity's idField. */
  fromField: string;
  /** Must equal some entity's idField. */
  toField: string;
  properties?: string[];
}

export interface StructuredMapping {
  entities: EntityFieldMapping[];
  edges: EdgeFieldMapping[];
}

export interface StructuredIngestResult {
  documentIds: string[];
  nodesCreated: string[];
  edgesCreated: string[];
  edgesRejected: { edge: string; reason: string }[];
  rowsProcessed: number;
  /** So the API layer can persist these via DocumentStore.appendMany. */
  documents: IndexedDocument[];
}

const VALID_NODE_TYPES: NodeType[] = ['Person', 'Organization', 'Asset', 'Location', 'Event'];

function validateMapping(mapping: StructuredMapping): void {
  if (!mapping || !Array.isArray(mapping.entities) || mapping.entities.length === 0) {
    throw new Error('mapping.entities must be a non-empty array');
  }
  const idFields = new Set<string>();
  for (const entity of mapping.entities) {
    if (!VALID_NODE_TYPES.includes(entity.type)) {
      throw new Error(`Unknown entity type "${entity.type}" in mapping (expected one of ${VALID_NODE_TYPES.join(', ')})`);
    }
    if (idFields.has(entity.idField)) {
      throw new Error(`Duplicate idField "${entity.idField}" declared for more than one entity in mapping`);
    }
    idFields.add(entity.idField);
  }
  for (const edge of mapping.edges ?? []) {
    if (!idFields.has(edge.fromField)) {
      throw new Error(`Edge mapping for relation "${edge.relation}" references fromField "${edge.fromField}" which is not any entity's idField`);
    }
    if (!idFields.has(edge.toField)) {
      throw new Error(`Edge mapping for relation "${edge.relation}" references toField "${edge.toField}" which is not any entity's idField`);
    }
  }
}

function coerceNumericValue(raw: string): string | number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return raw;
  // Preserve leading-zero strings (zip codes, ids like "007") as strings.
  if (/^-?0\d/.test(trimmed)) return raw;
  const value = Number(trimmed);
  return Number.isNaN(value) ? raw : value;
}

function pickProperties(row: Record<string, string>, fields: string[] = []): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = row[field];
    if (raw !== undefined && raw !== '') properties[field] = coerceNumericValue(raw);
  }
  return properties;
}

function isBlankRow(row: Record<string, string>): boolean {
  return Object.values(row).every((v) => (v ?? '').trim() === '');
}

function summarizeRow(row: Record<string, string>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

/**
 * Maps flat tabular records (CSV rows, JSON objects - already-structured
 * enterprise data, the kind of source real Foundry-style pipelines run
 * on) directly onto the ontology, as a sibling to the free-text
 * EntityExtractor/IngestionService pipeline. A declarative
 * StructuredMapping names which column produces which entity type and
 * which pairs of columns are linked by which declared relation; every
 * edge still goes through GraphStore's ontology validation, so a
 * mapping that names an undeclared relation or connects the wrong
 * entity types is rejected per row, not silently written - same
 * catch-and-continue precedent as IngestionService.
 */
export class StructuredRecordConnector {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorIndex,
    private readonly audit: AuditLog
  ) {}

  ingest(
    records: Record<string, string>[],
    mapping: StructuredMapping,
    source: string,
    sector: string,
    clearance: ClearanceLevel
  ): StructuredIngestResult {
    if (!Array.isArray(records)) {
      throw new Error('records must be an array of flat objects');
    }
    validateMapping(mapping);

    const nodesCreated: string[] = [];
    const edgesCreated: string[] = [];
    const edgesRejected: StructuredIngestResult['edgesRejected'] = [];
    const documents: IndexedDocument[] = [];

    // Suppress GraphStore's persist-on-every-write while the whole batch
    // runs, so a multi-thousand-row CSV doesn't rewrite the entire graph
    // to disk once per node/edge (see GraphStore.runBatch).
    this.graph.runBatch(() => {
      records.forEach((row, index) => {
        if (isBlankRow(row)) return;

        const documentId = `${source}#row${index}`;
        const nodeIdByIdField = new Map<string, string>();

        for (const entitySpec of mapping.entities) {
          const rawId = (row[entitySpec.idField] ?? '').trim();
          if (!rawId) continue;
          const rawLabel = entitySpec.labelField !== undefined ? (row[entitySpec.labelField] ?? '').trim() : rawId;
          if (!rawLabel) continue;

          // Namespace by type so ids from different entity columns can
          // never collide and silently overwrite an unrelated node via
          // GraphStore.upsertNode's overwrite-on-matching-id behavior.
          const nodeId = slugify(`${entitySpec.type}_${rawId}`);
          this.graph.upsertNode({
            id: nodeId,
            type: entitySpec.type,
            label: rawLabel,
            properties: pickProperties(row, entitySpec.properties),
            clearance,
            sourceDocId: documentId,
          });
          nodesCreated.push(nodeId);
          nodeIdByIdField.set(entitySpec.idField, nodeId);
        }

        for (const edgeSpec of mapping.edges) {
          const fromId = nodeIdByIdField.get(edgeSpec.fromField);
          const toId = nodeIdByIdField.get(edgeSpec.toField);
          // A missing endpoint means this row simply doesn't carry that
          // fact (e.g. a blank column) - not an ontology violation, so
          // skip silently rather than recording a spurious rejection.
          if (!fromId || !toId) continue;

          const edgeLabel = `${fromId}-[${edgeSpec.relation}]->${toId}`;
          try {
            this.graph.upsertEdge({
              source: fromId,
              target: toId,
              relation: edgeSpec.relation,
              properties: pickProperties(row, edgeSpec.properties),
              clearance,
              sourceDocId: documentId,
            });
            edgesCreated.push(edgeLabel);
          } catch (err) {
            edgesRejected.push({ edge: edgeLabel, reason: err instanceof Error ? err.message : String(err) });
          }
        }

        const doc: IndexedDocument = { id: documentId, text: summarizeRow(row), source, sector, clearance };
        this.vectors.addDocument(doc);
        documents.push(doc);
      });
    });

    this.audit.append('structured-record-connector', 'ingest_structured_records', {
      source,
      sector,
      clearance,
      rowsProcessed: records.length,
      documentIds: documents.map((d) => d.id),
      nodesCreated,
      edgesCreated,
      edgesRejected,
    });

    return {
      documentIds: documents.map((d) => d.id),
      nodesCreated,
      edgesCreated,
      edgesRejected,
      rowsProcessed: records.length,
      documents,
    };
  }
}
