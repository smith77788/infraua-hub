import * as crypto from 'crypto';
import { GraphStore } from '../graph/GraphStore';
import { VectorIndex } from '../vector/VectorIndex';
import { AuditLog } from '../audit/AuditLog';
import { ClearanceLevel } from '../security/Clearance';
import { EntityExtractor } from './EntityExtractor';

export interface IngestResult {
  documentId: string;
  nodesCreated: string[];
  edgesCreated: string[];
  edgesRejected: { edge: string; reason: string }[];
}

// Re-exported so existing callers keep importing it from here, while the rule
// itself lives in one dependency-free file both halves of the product read.
import { slugify } from './slug';
export { slugify };

/**
 * Wires ingestion together: extract facts from raw text, register the
 * document for semantic search, and write the extracted entities/
 * relations into the knowledge graph - all under one clearance level
 * and one audit entry per document, per docs/analyst-architecture.md
 * "Ingestion".
 */
export class IngestionService {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorIndex,
    private readonly audit: AuditLog,
    private readonly extractor: EntityExtractor = new EntityExtractor()
  ) {}

  ingest(
    text: string,
    sourceName: string,
    sector: string,
    clearance: ClearanceLevel,
    compartments: readonly string[] = []
  ): IngestResult {
    const documentId = `doc-${crypto.createHash('sha256').update(sourceName + text).digest('hex').slice(0, 12)}`;

    this.vectors.addDocument({
      id: documentId,
      text,
      source: sourceName,
      sector,
      clearance,
      ...(compartments.length ? { compartments: [...compartments] } : {}),
    });

    const extraction = this.extractor.extract(text);
    const nodesCreated: string[] = [];
    const edgesCreated: string[] = [];
    const edgesRejected: { edge: string; reason: string }[] = [];

    for (const n of extraction.nodes) {
      const id = slugify(n.label);
      this.graph.upsertNode({ id, type: n.type, label: n.label, properties: n.properties, clearance, compartments, sourceDocId: documentId });
      nodesCreated.push(id);
    }
    for (const e of extraction.edges) {
      const sourceId = slugify(e.sourceLabel);
      const targetId = slugify(e.targetLabel);
      if (!nodesCreated.includes(sourceId) || !nodesCreated.includes(targetId)) continue;
      const edgeLabel = `${sourceId}-[${e.relation}]->${targetId}`;
      try {
        this.graph.upsertEdge({
          source: sourceId,
          target: targetId,
          relation: e.relation,
          properties: e.properties,
          clearance,
          compartments,
          sourceDocId: documentId,
        });
        edgesCreated.push(edgeLabel);
      } catch (err) {
        // An ontology-manifest rejection (unknown relation, wrong endpoint
        // types) should not abort the rest of the document's ingestion -
        // record it and keep going, per the same "don't let one bad fact
        // crash the whole document" principle as the reviewer/fix loop in
        // the AI Software Factory core.
        edgesRejected.push({ edge: edgeLabel, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    this.audit.append('ingestion-service', 'ingest_document', {
      documentId,
      sourceName,
      sector,
      clearance,
      compartments,
      nodesCreated,
      edgesCreated,
      edgesRejected,
    });

    return { documentId, nodesCreated, edgesCreated, edgesRejected };
  }
}
