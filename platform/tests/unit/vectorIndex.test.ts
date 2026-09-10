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
