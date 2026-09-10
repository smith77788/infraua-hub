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

/**
 * Turns a label into a node id.
 *
 * The character class used to whitelist Latin plus Russian `а-яё`, which
 * silently deleted every Ukrainian letter outside that range - і, ї, є, ґ.
 * "Київобленерго" and "Киівобленерго" both came out as "кивобленерго", so two
 * different operators collided on one id and `upsertNode` overwrote one with
 * the other without a word. Whole-alphabet omissions like that cannot be
 * caught by reading the regex; it took feeding it real Ukrainian names.
 *
 * Now any letter or digit in any script survives, so the question "which
 * alphabets did we remember" no longer exists. NFKD also went: it decomposed
 * й into и plus a combining breve and the mark was then stripped, which is
 * the same class of bug one step removed.
 *
 * Ids produced before this change differ from ids produced after it, so a
 * graph persisted earlier keeps its old ids until it is re-ingested.
 */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '_');
}

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
