import { describe, expect, it } from 'bun:test';
import { resolveDuplicates, scorePair } from '../../core/analytics/EntityResolver';
import { buildAdjacency } from '../../core/analytics/GraphMetrics';
import { ClearanceLevel } from '../../core/security/Clearance';
import { GraphNode } from '../../core/graph/types';

function asset(id: string, label: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, type: 'Asset', label, properties, clearance: ClearanceLevel.PUBLIC, source_doc_ids: [] };
}

function person(id: string, label: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, type: 'Person', label, properties, clearance: ClearanceLevel.PUBLIC, source_doc_ids: [] };
}

/** Every pair, scored with the same function the fast path uses. */
function exhaustive(nodes: GraphNode[]): Set<string> {
  const { neighbors } = buildAdjacency(nodes, []);
  const found = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const candidate = scorePair(nodes[i], nodes[j], neighbors);
      if (candidate) found.add([candidate.a.id, candidate.b.id].sort().join('|'));
    }
  }
  return found;
}

function blocked(nodes: GraphNode[]): Set<string> {
  return new Set(
    resolveDuplicates(nodes, [], { limit: 10_000 }).candidates.map((c) => [c.a.id, c.b.id].sort().join('|')),
  );
}

/**
 * Blocking exists to make the resolver usable at real volume - measured at
 * 4000 entities it went from 116 s to under 0.2 s. That trade is only
 * acceptable if it costs no findings, so the test is not "is it fast" but
 * "does it find exactly what comparing every pair would have found".
 */
describe('blocking loses nothing the scorer would have accepted', () => {
  const corpus: GraphNode[] = [
    // Same name, different word order.
    asset('a1', 'Южноукраїнська АЕС'),
    asset('a2', 'АЕС Южноукраїнська'),
    // Corporate suffixes that carry no identity.
    asset('b1', 'Дніпро Енерго ТОВ'),
    asset('b2', 'Дніпро Енерго LLC'),
    // Initials.
    person('c1', 'J Doe'),
    person('c2', 'John Doe'),
    // Nothing in common but an identifier - the pair a name-based blocker misses.
    asset('d1', 'Трансформатор №5', { serial_number: 'X-900' }),
    asset('d2', 'Зовсім інша назва', { serial_number: 'X-900' }),
    // Different types sharing a name: never a candidate.
    asset('e1', 'Southern Cross'),
    person('e2', 'Southern Cross'),
    // Plain unrelated entities.
    asset('f1', 'Каховська ГЕС'),
    asset('f2', 'Бурштинська ТЕС'),
  ];

  it('agrees with comparing every pair', () => {
    expect(blocked(corpus)).toEqual(exhaustive(corpus));
  });

  it('still finds each kind of duplicate it is meant to find', () => {
    const found = blocked(corpus);
    expect(found.has('a1|a2')).toBe(true);
    expect(found.has('b1|b2')).toBe(true);
    expect(found.has('c1|c2')).toBe(true);
    expect(found.has('d1|d2')).toBe(true);
  });

  it('never proposes a pair across entity types', () => {
    expect(blocked(corpus).has('e1|e2')).toBe(false);
  });

  it('agrees with the exhaustive scan on a corpus full of near-misses', () => {
    // The case blocking is most likely to get wrong: many labels sharing most
    // of their tokens, so the discriminating token is the rare one.
    const noisy: GraphNode[] = [];
    for (let i = 0; i < 300; i++) {
      noisy.push(asset(`n${i}`, `Підстанція ${['Південна', 'Північна', 'Західна'][i % 3]} ${i}`));
    }
    noisy.push(asset('x1', 'Підстанція Бурштин'), asset('x2', 'Бурштин Підстанція'));
    expect(blocked(noisy)).toEqual(exhaustive(noisy));
  });
});

describe('blocking reports what it skipped', () => {
  it('drops a key that stops discriminating, and says so', () => {
    // 400 entities whose only shared token is one that every one of them has:
    // the key carries no information, so it is dropped rather than expanded
    // into 80 000 comparisons.
    const many = Array.from({ length: 400 }, (_, i) => asset(`m${i}`, `Підстанція ${i}`));
    const { stats } = resolveDuplicates(many, [], { maxBlockSize: 50 });
    expect(stats.blocksDropped).toBeGreaterThan(0);
    // A resolver that quietly stops looking is worse than a slow one, so the
    // count is part of the answer rather than a log line nobody reads.
    expect(stats.pairsCompared).toBeLessThan((many.length * many.length) / 2);
  });

  it('never drops an identifier block, however large', () => {
    // A thousand records sharing a tax id is the finding, not the noise.
    const shared = Array.from({ length: 200 }, (_, i) => asset(`s${i}`, `Обʼєкт ${i}`, { tax_id: '12345678' }));
    const { candidates, stats } = resolveDuplicates(shared, [], { maxBlockSize: 10, limit: 5 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].reasons.join(' ')).toContain('tax_id');
    expect(stats.pairsCompared).toBeGreaterThan(1000);
  });
});

describe('legal forms carry no identity, in any alphabet', () => {
  it('matches the same company as written by two registries', () => {
    // The Latin pair always scored 0.7; the Ukrainian one scored 0.27 and fell
    // below the floor, because the suffix list was Latin-only - and because
    // JavaScript's \b is defined against ASCII \w, so a Cyrillic suffix could
    // not have matched that mechanism even once it was added to the list.
    const found = blocked([
      asset('u1', 'Дніпро Енерго ТОВ'),
      asset('u2', 'Дніпро Енерго LLC'),
      asset('u3', 'ПрАТ Київобленерго'),
      asset('u4', 'Київобленерго'),
    ]);
    expect(found.has('u1|u2')).toBe(true);
    expect(found.has('u3|u4')).toBe(true);
  });

  it('does not merge two different companies that share only a legal form', () => {
    expect(blocked([asset('v1', 'ТОВ Схід'), asset('v2', 'ТОВ Захід')]).size).toBe(0);
  });
});
