import { ClearanceLevel, clearanceAtLeast } from '../security/Clearance';

export interface IndexedDocument {
  id: string;
  text: string;
  source: string;
  sector: string;
  clearance: ClearanceLevel;
}

export interface SearchHit {
  document: IndexedDocument;
  score: number;
}

const STOPWORDS = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'к', 'о', 'по', 'от', 'до', 'из', 'у', 'а', 'но', 'что', 'это', 'как', 'для',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'was', 'for', 'with', 'at', 'by',
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-zа-яё0-9]+/gi) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * A real TF-IDF vector index with cosine similarity ranking - not the
 * hash-seeded pseudo-embedding used in the uploaded reference scripts
 * (those return a deterministic-looking but semantically meaningless
 * vector, so their "search" only ever measures string-hash collision).
 * TF-IDF is a modest model, but it genuinely ranks documents by lexical
 * relevance to a query, which is the property an investigator needs
 * from search. Swapping in a real embedding model (bge-m3, etc.) later
 * only touches `vectorize()` - the ranking and clearance-filtering
 * logic stay the same.
 */
export class VectorIndex {
  private documents: IndexedDocument[] = [];
  private termDocFreq = new Map<string, number>();

  addDocument(doc: IndexedDocument): void {
    this.documents.push(doc);
    const terms = new Set(tokenize(doc.text));
    for (const term of terms) {
      this.termDocFreq.set(term, (this.termDocFreq.get(term) ?? 0) + 1);
    }
  }

  private idf(term: string): number {
    const df = this.termDocFreq.get(term) ?? 0;
    return Math.log((1 + this.documents.length) / (1 + df)) + 1;
  }

  private vectorize(text: string): Map<string, number> {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    for (const [term, count] of tf) {
      vec.set(term, (count / tokens.length) * this.idf(term));
    }
    return vec;
  }

  private cosine(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    for (const [term, weight] of a) {
      const other = b.get(term);
      if (other) dot += weight * other;
    }
    const normA = Math.sqrt(Array.from(a.values()).reduce((s, v) => s + v * v, 0));
    const normB = Math.sqrt(Array.from(b.values()).reduce((s, v) => s + v * v, 0));
    if (normA === 0 || normB === 0) return 0;
    return dot / (normA * normB);
  }

  /**
   * Removes every document from one ingestion source and rebuilds the term
   * statistics.
   *
   * The counts cannot be decremented in place: `termDocFreq` is document
   * frequency, and a term appearing three times in one removed document must
   * drop the frequency by one, not three. Recounting from what remains is the
   * only version that stays correct, and the index is small enough that the
   * cost is irrelevant next to being wrong.
   */
  removeBySource(sourcePrefix: string): number {
    if (!sourcePrefix) throw new Error('sourcePrefix is required');
    const matches = (id: string) => id === sourcePrefix || id.startsWith(`${sourcePrefix}#`);

    const before = this.documents.length;
    this.documents = this.documents.filter((d) => !matches(d.id) && d.source !== sourcePrefix);
    if (this.documents.length === before) return 0;

    this.termDocFreq = new Map();
    for (const doc of this.documents) {
      for (const term of new Set(tokenize(doc.text))) {
        this.termDocFreq.set(term, (this.termDocFreq.get(term) ?? 0) + 1);
      }
    }
    return before - this.documents.length;
  }

  search(query: string, clearance: ClearanceLevel, topN = 5): SearchHit[] {
    const queryVec = this.vectorize(query);
    const scored = this.documents
      .filter((doc) => clearanceAtLeast(clearance, doc.clearance))
      .map((doc) => ({ document: doc, score: this.cosine(queryVec, this.vectorize(doc.text)) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }

  size(): number {
    return this.documents.length;
  }
}
