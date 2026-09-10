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

  /**
   * Drops every stored document from one ingestion source.
   *
   * Retracting a batch from the graph while leaving its documents indexed is
   * worse than not retracting at all: search keeps answering with data the
   * operator believes is gone.
   */
  removeBySource(sourcePrefix: string): number {
    if (!sourcePrefix) throw new Error('sourcePrefix is required');
    const matches = (id: string) => id === sourcePrefix || id.startsWith(`${sourcePrefix}#`);
    const all = this.loadAll();
    const kept = all.filter((d) => !matches(d.id) && d.source !== sourcePrefix);
    if (kept.length === all.length) return 0;
    fs.writeFileSync(this.filePath, JSON.stringify(kept, null, 2), 'utf-8');
    return all.length - kept.length;
  }

  loadAll(): IndexedDocument[] {
    if (!fs.existsSync(this.filePath)) return [];
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }
}
