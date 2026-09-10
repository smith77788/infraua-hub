import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { RevisionLog } from '../../core/graph/RevisionLog';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';

/**
 * The two time axes, and the questions that need them kept apart.
 *
 * Transaction time answers "what did we know on the 14th, when the decision
 * was made" - not what is known now about the 14th. Valid time answers "how
 * did the grid actually stand on the 3rd". A substation destroyed on the 3rd
 * and reported on the 9th is a different fact on each axis, and an outage
 * review needs both: the first to reconstruct the grid, the second to judge
 * whether anybody could have acted.
 */
describe('bitemporal reconstruction', () => {
  let dir: string;
  let log: RevisionLog;
  let graph: GraphStore;

  const t = (day: number, hour = 12) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitemporal-'));
    log = new RevisionLog(path.join(dir, 'revisions.log'));
    graph = new GraphStore(path.join(dir, 'graph.json'), undefined, log);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reconstructs what was known then, not what is known now about then', () => {
    graph.upsertNode({ id: 'sub-1', type: 'Asset', label: 'Підстанція', properties: { status: 'робоча' } });
    log.append('upsert_node', graph.getNode('sub-1')!, t(5));

    // Learned on the 9th: it was destroyed on the 3rd.
    graph.upsertNode({
      id: 'sub-1',
      type: 'Asset',
      label: 'Підстанція',
      properties: { status: 'зруйнована' },
      validTo: t(3),
    });

    const now = graph.toJSON();
    expect(now.nodes[0].properties.status).toBe('зруйнована');

    // Replaying to the 6th must show the analyst what they had, which did not
    // include the destruction report.
    const then = graph.asOf({ asOf: t(6) });
    expect(then.nodes[0].properties.status).toBe('робоча');
    expect(then.basis.revisionsReplayed).toBeGreaterThan(0);
  });

  it('separates when a fact holds from when it was recorded', () => {
    graph.upsertNode({
      id: 'sub-2',
      type: 'Asset',
      label: 'Підстанція Друга',
      properties: {},
      validFrom: t(1),
      validTo: t(3),
    });

    // Valid time: the grid as it actually stood.
    expect(graph.asOf({ validAt: t(2) }).nodes).toHaveLength(1);
    expect(graph.asOf({ validAt: t(4) }).nodes).toHaveLength(0);
  });

  it('treats validity as half-open, so consecutive states never overlap', () => {
    // Closed intervals overlap for one instant and every aggregate across the
    // boundary then counts the same thing twice.
    graph.upsertNode({ id: 'a', type: 'Asset', label: 'A', validFrom: t(1), validTo: t(5) });
    graph.upsertNode({ id: 'b', type: 'Asset', label: 'B', validFrom: t(5) });
    expect(graph.asOf({ validAt: t(5) }).nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('combines both axes, which neither answers alone', () => {
    graph.upsertNode({ id: 'sub-3', type: 'Asset', label: 'Третя', properties: { status: 'робоча' } });
    log.append('upsert_node', graph.getNode('sub-3')!, t(2));
    graph.upsertNode({ id: 'sub-3', type: 'Asset', label: 'Третя', properties: { status: 'зруйнована' }, validFrom: t(8) });

    // What did we believe on the 4th about how things stood on the 9th?
    // Nothing about the destruction - it had not been recorded yet.
    const early = graph.asOf({ asOf: t(4), validAt: t(9) });
    expect(early.nodes[0].properties.status).toBe('робоча');

    // What do we believe now about the same instant?
    expect(graph.asOf({ validAt: t(9) }).nodes[0].properties.status).toBe('зруйнована');
  });

  it('keeps a retracted batch out of the reconstruction after the retraction', () => {
    graph.upsertNode({ id: 'bad-1', type: 'Asset', label: 'Помилковий запис', sourceDocId: 'smoke#1' });
    const beforeRetraction = log.head();
    graph.retractSource('smoke');

    // Before: the analyst saw it. After: they did not, and the reconstruction
    // has to agree with what was actually in front of them.
    expect(graph.asOf({ asOfSeq: beforeRetraction }).nodes.map((n) => n.id)).toContain('bad-1');
    expect(graph.asOf({ asOfSeq: log.head() }).nodes.map((n) => n.id)).not.toContain('bad-1');
  });

  it('carries validity forward when a later assertion says nothing about it', () => {
    graph.upsertNode({ id: 'sub-4', type: 'Asset', label: 'Четверта', validFrom: t(1), validTo: t(4) });
    graph.upsertNode({ id: 'sub-4', type: 'Asset', label: 'Четверта, уточнена назва' });
    const node = graph.getNode('sub-4')!;
    expect(node.valid_to).toBe(t(4));
    expect(node.label).toContain('уточнена');
  });

  it('applies need-to-know to the reconstruction, not only to the present', () => {
    graph.upsertNode({ id: 'open', type: 'Asset', label: 'Відкритий' });
    graph.upsertNode({ id: 'closed', type: 'Asset', label: 'Закритий', compartments: ['grid'] });
    const now = new Date().toISOString();

    const outsider = graph.asOf({ asOf: now }, viewer(ClearanceLevel.TOP_SECRET, []));
    expect(outsider.nodes.map((n) => n.id)).toEqual(['open']);
    // Markings travel with the record through replay: a fact classified today
    // was classified in the reconstruction too.
    const insider = graph.asOf({ asOf: now }, viewer(ClearanceLevel.PUBLIC, ['grid']));
    expect(insider.nodes.map((n) => n.id)).toContain('closed');
  });

  it('refuses to invent a past when it keeps no history', () => {
    const historyless = new GraphStore(path.join(dir, 'plain.json'));
    expect(() => historyless.asOf({ asOf: t(1) })).toThrow(/no revision history/);
  });

  describe('diff', () => {
    it('names what appeared, what went and which fields moved', () => {
      graph.upsertNode({ id: 'keep', type: 'Asset', label: 'Лишиться', properties: { voltage: 110000 } });
      graph.upsertNode({ id: 'goes', type: 'Asset', label: 'Зникне', sourceDocId: 'batch#1' });
      // The sequence, not the clock: these writes land in the same millisecond
      // and a timestamp cannot tell them apart.
      const mid = log.head();

      graph.upsertNode({ id: 'keep', type: 'Asset', label: 'Лишиться', properties: { voltage: 330000 } });
      graph.upsertNode({ id: 'arrives', type: 'Asset', label: 'Зʼявиться' });
      graph.retractSource('batch');

      const diff = graph.diff(mid, log.head());
      expect(diff.added.nodes.map((n) => n.id)).toEqual(['arrives']);
      expect(diff.removed.nodes.map((n) => n.id)).toEqual(['goes']);
      // Named, not counted: "one field changed" does not tell an analyst
      // whether to care.
      expect(diff.changed).toEqual([{ id: 'keep', label: 'Лишиться', fields: ['properties.voltage'] }]);
    });

    it('reports a reclassification as a change worth seeing', () => {
      graph.upsertNode({ id: 'n', type: 'Asset', label: 'Вузол', clearance: ClearanceLevel.PUBLIC });
      const mid = log.head();
      graph.upsertNode({ id: 'n', type: 'Asset', label: 'Вузол', clearance: ClearanceLevel.SECRET });
      expect(graph.diff(mid, log.head()).changed[0].fields).toContain('clearance');
    });
  });

  describe('cursors', () => {
    it('separates two changes made in the same millisecond', () => {
      // A wall-clock instant cannot, and ingestion makes hundreds per
      // millisecond. This is why a finding pins a sequence, not only a time.
      graph.upsertNode({ id: 'x', type: 'Asset', label: 'Перший' });
      const afterFirst = log.head();
      graph.upsertNode({ id: 'y', type: 'Asset', label: 'Другий' });

      expect(graph.asOf({ asOfSeq: afterFirst }).nodes.map((n) => n.id)).toEqual(['x']);
      expect(graph.asOf({ asOfSeq: log.head() }).nodes.map((n) => n.id)).toEqual(['x', 'y']);
    });

    it('prefers the exact cursor when both are given', () => {
      graph.upsertNode({ id: 'x', type: 'Asset', label: 'Перший' });
      const afterFirst = log.head();
      graph.upsertNode({ id: 'y', type: 'Asset', label: 'Другий' });

      const result = graph.asOf({ asOf: new Date().toISOString(), asOfSeq: afterFirst });
      expect(result.nodes.map((n) => n.id)).toEqual(['x']);
      expect(result.basis.asOfSeq).toBe(afterFirst);
    });
  });
});
