import { VectorIndex } from '../../core/vector/VectorIndex';
import { ClearanceLevel } from '../../core/security/Clearance';
import { describe, expect, it } from 'bun:test';

describe('VectorIndex (TF-IDF)', () => {
  it('ranks the lexically closer document first', () => {
    const index = new VectorIndex();
    index.addDocument({ id: 'd1', text: 'Director approved a no-bid procurement contract with a shell vendor.', source: 'a', sector: 'Corporate', clearance: ClearanceLevel.PUBLIC });
    index.addDocument({ id: 'd2', text: 'The factory production line requires new safety equipment next quarter.', source: 'b', sector: 'Corporate', clearance: ClearanceLevel.PUBLIC });

    const hits = index.search('procurement contract fraud', ClearanceLevel.PUBLIC);
    expect(hits[0].document.id).toBe('d1');
  });

  it('filters out documents above the requester clearance', () => {
    const index = new VectorIndex();
    index.addDocument({ id: 'public-doc', text: 'quarterly earnings report summary', source: 'a', sector: 'Corporate', clearance: ClearanceLevel.PUBLIC });
    index.addDocument({ id: 'secret-doc', text: 'quarterly earnings classified breakdown', source: 'b', sector: 'Corporate', clearance: ClearanceLevel.SECRET });

    const publicHits = index.search('quarterly earnings', ClearanceLevel.PUBLIC);
    expect(publicHits.map((h) => h.document.id)).toEqual(['public-doc']);

    const secretHits = index.search('quarterly earnings', ClearanceLevel.SECRET);
    expect(secretHits.map((h) => h.document.id).sort()).toEqual(['public-doc', 'secret-doc']);
  });

  it('returns no hits for a query with no lexical overlap', () => {
    const index = new VectorIndex();
    index.addDocument({ id: 'd1', text: 'alpha beta gamma', source: 'a', sector: 'Corporate', clearance: ClearanceLevel.PUBLIC });
    expect(index.search('completely unrelated zzz', ClearanceLevel.PUBLIC)).toHaveLength(0);
  });
});

describe('the inverted index ranks exactly as recomputing everything did', () => {
  const corpus = [
    { id: 'd1', text: 'Підстанція Південна отримала аварійне живлення від Дніпровської ТЕС' },
    { id: 'd2', text: 'Дніпровська ТЕС зупинила третій блок на планове обслуговування' },
    { id: 'd3', text: 'Водоканал Херсона перейшов на резервне живлення' },
    { id: 'd4', text: 'Аварійне живлення лікарні відновлено, підстанція працює' },
    { id: 'd5', text: 'Погода: сильний вітер у Карпатах' },
  ];

  const build = () => {
    const index = new VectorIndex();
    for (const doc of corpus) {
      index.addDocument({ ...doc, source: 's', sector: 'energy', clearance: ClearanceLevel.PUBLIC });
    }
    return index;
  };

  /** The straightforward O(corpus) scoring the index used to do per query. */
  const naive = (query: string) => {
    // Mirrors the index's own tokenizer: any letter in any script, minus the
    // stopwords these documents actually contain.
    const stop = ['и', 'в', 'на', 'від', 'у', 'з', 'та', 'і', 'й', 'про', 'що', 'як', 'це', 'для', 'до', 'за', 'the', 'a', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'was', 'for', 'with', 'at', 'by'];
    const tokenize = (text: string) =>
      (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !stop.includes(t));
    const df = new Map<string, number>();
    for (const doc of corpus) for (const term of new Set(tokenize(doc.text))) df.set(term, (df.get(term) ?? 0) + 1);
    const idf = (term: string) => Math.log((1 + corpus.length) / (1 + (df.get(term) ?? 0))) + 1;
    const vectorize = (text: string) => {
      const tokens = tokenize(text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      const vec = new Map<string, number>();
      for (const [term, count] of tf) vec.set(term, (count / tokens.length) * idf(term));
      return vec;
    };
    const cosine = (a: Map<string, number>, b: Map<string, number>) => {
      let dot = 0;
      for (const [term, weight] of a) dot += weight * (b.get(term) ?? 0);
      const norm = (v: Map<string, number>) => Math.sqrt(Array.from(v.values()).reduce((s, x) => s + x * x, 0));
      const na = norm(a);
      const nb = norm(b);
      return na === 0 || nb === 0 ? 0 : dot / (na * nb);
    };
    const q = vectorize(query);
    return corpus
      .map((doc) => ({ id: doc.id, score: cosine(q, vectorize(doc.text)) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  };

  for (const query of ['аварійне живлення', 'Дніпровська ТЕС', 'підстанція', 'вітер Карпати']) {
    it(`agrees on "${query}"`, () => {
      const expected = naive(query);
      const actual = build().search(query, ClearanceLevel.TOP_SECRET, 10);
      expect(actual.map((h) => h.document.id)).toEqual(expected.map((h) => h.id));
      actual.forEach((hit, i) => expect(hit.score).toBeCloseTo(expected[i].score, 10));
    });
  }

  it('rebuilds after a later document changes the corpus statistics', () => {
    // IDF depends on the whole corpus, so every stored weight goes stale the
    // moment a document arrives. Serving the previous weights would rank by a
    // corpus that no longer exists, and nothing would look wrong.
    const index = build();
    index.search('живлення', ClearanceLevel.TOP_SECRET, 5);
    for (let i = 0; i < 20; i++) {
      index.addDocument({ id: `extra-${i}`, text: 'живлення живлення живлення', source: 's', sector: 'x', clearance: ClearanceLevel.PUBLIC });
    }
    const after = index.search('живлення', ClearanceLevel.TOP_SECRET, 30);
    expect(after.length).toBe(23);
    expect(after[0].document.text).toContain('живлення живлення');
  });

  it('rebuilds after a retraction too', () => {
    const index = build();
    index.search('живлення', ClearanceLevel.TOP_SECRET, 5);
    index.removeBySource('s');
    expect(index.search('живлення', ClearanceLevel.TOP_SECRET, 5)).toHaveLength(0);
  });
});

describe('Ukrainian text is indexed whole', () => {
  it('does not cut a word at і, ї, є or ґ', () => {
    // The class used to be [a-zа-яё0-9] — the Russian alphabet — so those four
    // letters acted as separators: "Київобленерго" indexed as "ки" +
    // "вобленерго" and "Дніпро" as "дн" + "про". Worse than returning nothing:
    // the stumps matched each other often enough to look like working search,
    // while "Дніпро" and "Дніпровська" shared no term at all.
    const index = new VectorIndex();
    index.addDocument({ id: 'k', text: 'ПрАТ Київобленерго повідомляє про аварійне відключення', source: 's', sector: 'energy', clearance: ClearanceLevel.PUBLIC });
    index.addDocument({ id: 'd', text: 'Дніпровська ТЕС зупинила блок', source: 's', sector: 'energy', clearance: ClearanceLevel.PUBLIC });
    index.addDocument({ id: 'g', text: 'Ґанок їдальні відремонтовано', source: 's', sector: 'other', clearance: ClearanceLevel.PUBLIC });

    expect(index.search('Київобленерго', ClearanceLevel.PUBLIC, 5).map((h) => h.document.id)).toEqual(['k']);
    expect(index.search('Ґанок', ClearanceLevel.PUBLIC, 5).map((h) => h.document.id)).toEqual(['g']);
    // A whole-word index does not match a different word that shares a stump.
    expect(index.search('Дніпро', ClearanceLevel.PUBLIC, 5)).toHaveLength(0);
    expect(index.search('Дніпровська', ClearanceLevel.PUBLIC, 5).map((h) => h.document.id)).toEqual(['d']);
  });
});
