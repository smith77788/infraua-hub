import * as fs from 'fs';
import * as path from 'path';
import { IndexedDocument } from '../vector/VectorIndex';

/**
 * Persists ingested raw documents so the VectorIndex (in-memory only)
 * can be rehydrated on restart without re-running extraction or
 * duplicating audit entries. GraphStore persists itself; this is the
 * equivalent for the vector side.
 */
export class DocumentStore {
  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf-8');
  }

  append(doc: IndexedDocument): void {
    const docs = this.loadAll();
    docs.push(doc);
    fs.writeFileSync(this.filePath, JSON.stringify(docs, null, 2), 'utf-8');
  }

  /**
   * Batched form of append() - one read, one write - for callers that
   * produce many documents per call (e.g. one per structured-ingestion
   * row) instead of the single-document-per-call free-text path.
   */
  appendMany(docs: IndexedDocument[]): void {
    if (docs.length === 0) return;
    const merged = this.loadAll().concat(docs);
    fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
  }

  loadAll(): IndexedDocument[] {
    if (!fs.existsSync(this.filePath)) return [];
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }
}
