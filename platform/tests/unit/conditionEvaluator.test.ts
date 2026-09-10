import { describe, expect, it } from 'bun:test';
import { evaluateCondition, haversineKm, matchNodes } from '../../core/alerts/ConditionEvaluator';
import { ClearanceLevel } from '../../core/security/Clearance';
import { AlertCondition } from '../../core/alerts/AlertRule';
import { GraphNode } from '../../core/graph/types';

function node(id: string, type: GraphNode['type'], label: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, type, label, properties, clearance: ClearanceLevel.PUBLIC, source_doc_ids: [] };
}

const ctx = (nodes: GraphNode[]) => ({ nodes, edges: [], risk: new Map() });

describe('property predicates', () => {
  const sub = node('s1', 'Asset', 'Підстанція', { voltage: 330000, operator: 'НЕК Укренерго' });

  it('compares numbers as numbers and refuses to guess otherwise', () => {
    const yes: AlertCondition = { kind: 'entity', properties: [{ property: 'voltage', op: 'gte', value: 330000 }] };
    expect(evaluateCondition(yes, sub, ctx([sub]))).not.toBeNull();

    // "110000" against 220000 as strings answers a different question, wrongly.
    const stringy = node('s2', 'Asset', 'Інша', { voltage: '999999' });
    expect(evaluateCondition(yes, stringy, ctx([stringy]))).toBeNull();
  });

  it('matches on substring and on presence', () => {
    expect(
      evaluateCondition({ kind: 'entity', properties: [{ property: 'operator', op: 'contains', value: 'укренерго' }] }, sub, ctx([sub])),
    ).not.toBeNull();
    expect(evaluateCondition({ kind: 'entity', properties: [{ property: 'missing', op: 'exists' }] }, sub, ctx([sub]))).toBeNull();
  });

  it('says what fired, not just that something did', () => {
    const evidence = evaluateCondition(
      { kind: 'entity', nodeType: 'Asset', properties: [{ property: 'voltage', op: 'gte', value: 330000 }] },
      sub,
      ctx([sub]),
    );
    expect(evidence!.join('; ')).toContain('voltage=330000 ≥ 330000');
  });
});

describe('geofence and proximity', () => {
  const kyiv = { lat: 50.45, lon: 30.52 };

  it('measures great-circle distance, not degrees', () => {
    // Kyiv to Lviv is about 470 km.
    expect(haversineKm(kyiv, { lat: 49.84, lon: 24.03 })).toBeGreaterThan(450);
    expect(haversineKm(kyiv, { lat: 49.84, lon: 24.03 })).toBeLessThan(490);
  });

  it('skips a node with no usable coordinates instead of placing it at zero', () => {
    // Treating a missing coordinate as 0,0 would put the node in the Atlantic
    // and quietly exclude it — or, with a large radius, quietly include it.
    const nowhere = node('n1', 'Asset', 'Без координат');
    const fence: AlertCondition = { kind: 'geofence', lat: 0, lon: 0, radiusKm: 20000 };
    expect(evaluateCondition(fence, nowhere, ctx([nowhere]))).toBeNull();
  });

  /** The scan the grid index replaced. */
  function bruteForce(nodes: GraphNode[], radiusKm: number): string[] {
    const events = nodes.filter((n) => n.type === 'Event');
    return nodes
      .filter((n) => n.type === 'Asset')
      .filter((asset) =>
        events.some(
          (event) =>
            haversineKm(
              { lat: asset.properties.lat as number, lon: asset.properties.lon as number },
              { lat: event.properties.lat as number, lon: event.properties.lon as number },
            ) <= radiusKm,
        ),
      )
      .map((n) => n.id)
      .sort();
  }

  const spread: GraphNode[] = [];
  for (let i = 0; i < 400; i++) {
    spread.push(node(`a${i}`, 'Asset', `Обʼєкт ${i}`, { lat: 44.2 + (i % 81) / 10, lon: 22 + (i % 182) / 10 }));
  }
  for (let i = 0; i < 25; i++) {
    spread.push(node(`e${i}`, 'Event', `Подія ${i}`, { lat: 45 + (i % 7), lon: 23 + (i % 16) }));
  }

  for (const radiusKm of [5, 15, 60, 150, 400]) {
    it(`agrees with a full scan at ${radiusKm} km`, () => {
      // The grid only narrows the search; the exact distance still decides. A
      // radius spanning several cells is the case that would silently truncate
      // if the lookup did not widen — a geofence missing what it was drawn around.
      const condition: AlertCondition = {
        kind: 'all',
        of: [
          { kind: 'entity', nodeType: 'Asset' },
          { kind: 'proximity', nearType: 'Event', radiusKm },
        ],
      };
      const matched = matchNodes(condition, ctx(spread)).map((m) => m.node.id).sort();
      expect(matched).toEqual(bruteForce(spread, radiusKm));
    });
  }

  it('finds a neighbour across a cell boundary', () => {
    // Two points either side of a whole-degree line, 2 km apart.
    const pair = [
      node('west', 'Asset', 'Захід', { lat: 49.995, lon: 30.5 }),
      node('east', 'Event', 'Схід', { lat: 50.005, lon: 30.5 }),
    ];
    const condition: AlertCondition = { kind: 'proximity', nearType: 'Event', radiusKm: 5 };
    expect(evaluateCondition(condition, pair[0], ctx(pair))).not.toBeNull();
  });
});

describe('boolean combinations', () => {
  const sub = node('s1', 'Asset', 'Підстанція Південна', { voltage: 750000 });

  it('all requires every branch and reports all of them', () => {
    const evidence = evaluateCondition(
      {
        kind: 'all',
        of: [
          { kind: 'entity', nodeType: 'Asset' },
          { kind: 'entity', labelContains: 'Південна' },
        ],
      },
      sub,
      ctx([sub]),
    );
    expect(evidence).toHaveLength(2);
  });

  it('any stops at the first branch that fires', () => {
    const evidence = evaluateCondition(
      {
        kind: 'any',
        of: [
          { kind: 'entity', labelContains: 'нема такого' },
          { kind: 'entity', nodeType: 'Asset' },
        ],
      },
      sub,
      ctx([sub]),
    );
    expect(evidence).toEqual(['is a Asset']);
  });
});
