import { describe, expect, it } from 'bun:test';
import { SnapshotStore, contentHashOf } from '../../core/lineage/SnapshotStore';

const record = (store: SnapshotStore, count: number, records: unknown = { n: count }) =>
  store.record({
    source: 'firms',
    kind: 'infraua',
    recordCount: count,
    contentHash: contentHashOf(records),
    actor: 'tester',
  });

describe('content hashing', () => {
  it('ignores the order of keys, so a reordered feed is not a changed feed', () => {
    // Most feeds change something on every call. A hash that moves every time
    // cannot tell "the data changed" from "the envelope changed".
    expect(contentHashOf({ a: 1, b: 2 })).toBe(contentHashOf({ b: 2, a: 1 }));
    expect(contentHashOf([{ x: 1, y: 2 }])).toBe(contentHashOf([{ y: 2, x: 1 }]));
  });

  it('does not ignore the order of records, which is data', () => {
    expect(contentHashOf([1, 2])).not.toBe(contentHashOf([2, 1]));
  });

  it('notices a changed value', () => {
    expect(contentHashOf({ a: 1 })).not.toBe(contentHashOf({ a: 2 }));
  });
});

describe('what a batch says about its source', () => {
  it('has nothing to compare the first one with, and says so', () => {
    const store = new SnapshotStore();
    const first = record(store, 100);
    expect(first.verdict).toBe('first');
    expect(first.baseline).toBeNull();
  });

  it('calls a normal batch normal', () => {
    const store = new SnapshotStore();
    for (const n of [100, 105, 98]) record(store, n);
    expect(record(store, 102).verdict).toBe('normal');
  });

  it('catches the failure that has no other symptom', () => {
    // A source returning HTTP 200 with a third of its usual rows is not down.
    // It is broken in the way that reaches the graph and looks like a quiet day.
    const store = new SnapshotStore();
    for (const n of [1000, 1100, 950, 1050]) record(store, n);
    const shrunk = record(store, 120);
    expect(shrunk.verdict).toBe('shrunk');
    expect(shrunk.baseline).toBeGreaterThan(900);
    expect(shrunk.note).toContain('не тим');
  });

  it('catches a feed that has frozen', () => {
    // Still answering, still fast, returning yesterday's rows. Content hashing
    // is the only thing that sees it.
    const store = new SnapshotStore();
    record(store, 50, { rows: ['a', 'b'] });
    const same = record(store, 50, { rows: ['a', 'b'] });
    expect(same.verdict).toBe('unchanged');
    expect(same.note).toContain('заморожене');
  });

  it('separates an empty answer from an unreachable source', () => {
    const store = new SnapshotStore();
    record(store, 100);
    const empty = record(store, 0, {});
    expect(empty.verdict).toBe('empty');
    expect(empty.note).toContain('відповіло і не дало нічого');
  });

  it('notices a sudden widening too', () => {
    const store = new SnapshotStore();
    for (const n of [10, 12, 11]) record(store, n);
    expect(record(store, 400).verdict).toBe('grew');
  });

  it('never refuses a batch, whatever it thinks of it', () => {
    // Refusing would trade a monitoring problem for data loss, and a feed
    // legitimately has quiet days.
    const store = new SnapshotStore();
    for (const n of [1000, 1000, 1000]) record(store, n);
    const shrunk = record(store, 1);
    expect(shrunk.recordCount).toBe(1);
    expect(store.size()).toBe(4);
  });

  it('uses the median, so one outlier does not move the baseline', () => {
    const store = new SnapshotStore();
    for (const n of [100, 100, 100, 100, 100_000]) record(store, n);
    // With a mean baseline, 100 would now read as a catastrophic shrink.
    expect(record(store, 100).verdict).toBe('normal');
  });
});

describe('the health board', () => {
  it('shows the latest state of each source', () => {
    const store = new SnapshotStore();
    record(store, 100);
    store.record({ source: 'ioda', kind: 'infraua', recordCount: 5, contentHash: 'x', actor: 't' });
    expect(store.latestPerSource().map((s) => s.source).sort()).toEqual(['firms', 'ioda']);
  });

  it('singles out the sources worth looking at', () => {
    const store = new SnapshotStore();
    for (const n of [500, 520, 480]) record(store, n);
    record(store, 10);
    store.record({ source: 'healthy', kind: 'x', recordCount: 3, contentHash: 'a', actor: 't' });

    const suspect = store.suspect().map((s) => s.source);
    expect(suspect).toContain('firms');
    expect(suspect).not.toContain('healthy');
  });
});
