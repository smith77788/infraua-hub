import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RiskScorer, RiskSignalConfig } from '../../core/analytics/RiskScorer';
import { ClearanceLevel } from '../../core/security/Clearance';
import { GraphEdge, GraphNode, NodeType } from '../../core/graph/types';
import { describe, expect, it } from 'bun:test';

function node(id: string, type: NodeType = 'Person', properties: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    label: id,
    properties,
    clearance: ClearanceLevel.PUBLIC,
    source_doc_ids: [],
  };
}

function edge(
  source: string,
  target: string,
  relation: string,
  properties: Record<string, unknown> = {},
): GraphEdge {
  return { source, target, relation, properties, clearance: ClearanceLevel.PUBLIC, source_doc_ids: [] };
}

const signal = (over: Partial<RiskSignalConfig> & Pick<RiskSignalConfig, 'id' | 'type' | 'weight'>): RiskSignalConfig => ({
  label: over.id,
  reason: 'test signal',
  ...over,
});

describe('RiskScorer', () => {
  it('reports the signals behind a score, never a bare number', () => {
    const scorer = new RiskScorer([
      signal({ id: 'hidden', type: 'relation', relation: 'HIDDEN_BENEFICIARY_OF', weight: 30 }),
    ]);

    const nodes = [node('p1'), node('o1', 'Organization')];
    const edges = [edge('p1', 'o1', 'HIDDEN_BENEFICIARY_OF')];

    const assessment = scorer.score(nodes, edges).find((a) => a.id === 'p1')!;
    expect(assessment.score).toBe(30);
    expect(assessment.signals).toHaveLength(1);
    expect(assessment.signals[0].id).toBe('hidden');
    expect(assessment.signals[0].contribution).toBe(30);
    // Evidence must name what actually triggered it, so a reviewer can check it.
    expect(assessment.signals[0].evidence).toContain('HIDDEN_BENEFICIARY_OF');
    expect(assessment.signals[0].evidence).toContain('o1');
  });

  it('scores an entity with no matching signal at zero, in the low band', () => {
    const scorer = new RiskScorer([
      signal({ id: 'hidden', type: 'relation', relation: 'HIDDEN_BENEFICIARY_OF', weight: 30 }),
    ]);
    const assessment = scorer.score([node('p1')], [])[0];
    expect(assessment.score).toBe(0);
    expect(assessment.band).toBe('low');
    expect(assessment.signals).toEqual([]);
  });

  it('fires a combination signal only when every relation is present', () => {
    const scorer = new RiskScorer([
      signal({
        id: 'self_dealing',
        type: 'relation_combination',
        relations: ['AWARDED_CONTRACT', 'HIDDEN_BENEFICIARY_OF'],
        weight: 35,
      }),
    ]);

    const nodes = [node('p1'), node('o1', 'Organization'), node('o2', 'Organization')];

    const onlyOne = scorer
      .score(nodes, [edge('p1', 'o1', 'AWARDED_CONTRACT')])
      .find((a) => a.id === 'p1')!;
    expect(onlyOne.score).toBe(0);

    const both = scorer
      .score(nodes, [edge('p1', 'o1', 'AWARDED_CONTRACT'), edge('p1', 'o2', 'HIDDEN_BENEFICIARY_OF')])
      .find((a) => a.id === 'p1')!;
    expect(both.score).toBe(35);
  });

  it('sums a numeric edge property against its threshold', () => {
    const scorer = new RiskScorer([
      signal({ id: 'value', type: 'property_sum', property: 'amount', threshold: 1_000_000, weight: 20 }),
    ]);
    const nodes = [node('p1'), node('o1', 'Organization'), node('o2', 'Organization')];

    const under = scorer
      .score(nodes, [edge('p1', 'o1', 'AWARDED_CONTRACT', { amount: 400_000 })])
      .find((a) => a.id === 'p1')!;
    expect(under.score).toBe(0);

    // Neither contract alone crosses the threshold; together they do.
    const over = scorer
      .score(nodes, [
        edge('p1', 'o1', 'AWARDED_CONTRACT', { amount: 600_000 }),
        edge('p1', 'o2', 'AWARDED_CONTRACT', { amount: 600_000 }),
      ])
      .find((a) => a.id === 'p1')!;
    expect(over.score).toBe(20);
    expect(over.signals[0].evidence).toContain('1,200,000');
  });

  it('ignores non-numeric property values instead of coercing them', () => {
    const scorer = new RiskScorer([
      signal({ id: 'value', type: 'property_sum', property: 'amount', threshold: 1, weight: 20 }),
    ]);
    const nodes = [node('p1'), node('o1', 'Organization')];
    const assessment = scorer
      .score(nodes, [edge('p1', 'o1', 'AWARDED_CONTRACT', { amount: 'lots' })])
      .find((a) => a.id === 'p1')!;
    expect(assessment.score).toBe(0);
  });

  it('flags the broker via betweenness and the endpoints of a bridge', () => {
    const scorer = new RiskScorer([
      signal({ id: 'broker', type: 'betweenness', threshold: 0.5, weight: 25 }),
      signal({ id: 'connector', type: 'bridge_endpoint', weight: 15 }),
    ]);

    const nodes = ['x1', 'x2', 'x3', 'broker', 'y1', 'y2', 'y3'].map((id) => node(id));
    const edges = [
      edge('x1', 'x2', 'AFFILIATED_WITH'),
      edge('x2', 'x3', 'AFFILIATED_WITH'),
      edge('x3', 'x1', 'AFFILIATED_WITH'),
      edge('x1', 'broker', 'AFFILIATED_WITH'),
      edge('broker', 'y1', 'AFFILIATED_WITH'),
      edge('y1', 'y2', 'AFFILIATED_WITH'),
      edge('y2', 'y3', 'AFFILIATED_WITH'),
      edge('y3', 'y1', 'AFFILIATED_WITH'),
    ];

    const results = scorer.score(nodes, edges);
    const broker = results.find((a) => a.id === 'broker')!;
    const peripheral = results.find((a) => a.id === 'y2')!;

    expect(broker.signals.map((s) => s.id).sort()).toEqual(['broker', 'connector']);
    expect(broker.score).toBe(40);
    expect(peripheral.score).toBe(0);
    // The ranking must put the broker first — that is the whole point.
    expect(results[0].id).toBe('broker');
  });

  it('caps the total at 100 so a pile of small signals cannot outrank a severe one', () => {
    const scorer = new RiskScorer([
      signal({ id: 'a', type: 'relation', relation: 'R', weight: 60 }),
      signal({ id: 'b', type: 'degree', threshold: 1, weight: 60 }),
    ]);
    const nodes = [node('p1'), node('o1', 'Organization')];
    const assessment = scorer.score(nodes, [edge('p1', 'o1', 'R')]).find((a) => a.id === 'p1')!;

    expect(assessment.score).toBe(100);
    // The uncapped contributions stay visible, so the cap is not hiding evidence.
    expect(assessment.signals.reduce((sum, s) => sum + s.contribution, 0)).toBe(120);
  });

  it('assigns bands at the documented boundaries', () => {
    const banded = (weight: number) => {
      const scorer = new RiskScorer([signal({ id: 's', type: 'degree', threshold: 1, weight })]);
      const nodes = [node('p1'), node('o1', 'Organization')];
      return scorer.score(nodes, [edge('p1', 'o1', 'R')]).find((a) => a.id === 'p1')!.band;
    };

    expect(banded(19)).toBe('low');
    expect(banded(20)).toBe('elevated');
    expect(banded(44)).toBe('elevated');
    expect(banded(45)).toBe('high');
    expect(banded(69)).toBe('high');
    expect(banded(70)).toBe('severe');
  });

  it('skips an unknown signal type rather than failing the whole assessment', () => {
    const scorer = new RiskScorer([
      { id: 'bogus', label: 'bogus', type: 'not_a_real_type' as never, weight: 50, reason: '' },
      signal({ id: 'real', type: 'relation', relation: 'R', weight: 10 }),
    ]);
    const nodes = [node('p1'), node('o1', 'Organization')];
    const assessment = scorer.score(nodes, [edge('p1', 'o1', 'R')]).find((a) => a.id === 'p1')!;

    expect(assessment.score).toBe(10);
    expect(assessment.signals.map((s) => s.id)).toEqual(['real']);
  });

  it('only sees relations present in the snapshot it was given', () => {
    // The clearance property: a filtered-out edge must not raise a visible
    // entity's score, since the score would then hint at the hidden relation.
    const scorer = new RiskScorer([
      signal({ id: 'hidden', type: 'relation', relation: 'HIDDEN_BENEFICIARY_OF', weight: 30 }),
    ]);
    const visibleOnly = scorer.score([node('p1')], []).find((a) => a.id === 'p1')!;
    expect(visibleOnly.score).toBe(0);
  });
});

describe('RiskScorer.fromFile', () => {
  it('loads the shipped config and scores the documented fraud pattern', () => {
    const scorer = RiskScorer.fromFile(path.join(__dirname, '..', '..', 'config', 'risk_signals.json'));

    const nodes = [node('john-doe'), node('acme', 'Organization'), node('shell', 'Organization')];
    const edges = [
      edge('john-doe', 'acme', 'AWARDED_CONTRACT', { amount: 1_500_000 }),
      edge('john-doe', 'shell', 'HIDDEN_BENEFICIARY_OF'),
    ];

    const assessment = scorer.score(nodes, edges).find((a) => a.id === 'john-doe')!;
    const firedIds = assessment.signals.map((s) => s.id);

    expect(firedIds).toContain('hidden_beneficiary');
    expect(firedIds).toContain('contract_awarding');
    expect(firedIds).toContain('self_dealing_pattern');
    expect(firedIds).toContain('value_concentration');
    expect(assessment.band).toBe('severe');
  });

  it('rejects a config whose signals are malformed rather than scoring on nonsense', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-config-'));
    try {
      const noArray = path.join(dir, 'no-array.json');
      fs.writeFileSync(noArray, JSON.stringify({ signals: 'nope' }));
      expect(() => RiskScorer.fromFile(noArray)).toThrow(/signals/);

      const noWeight = path.join(dir, 'no-weight.json');
      fs.writeFileSync(noWeight, JSON.stringify({ signals: [{ id: 'x', type: 'degree' }] }));
      expect(() => RiskScorer.fromFile(noWeight)).toThrow(/weight/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
