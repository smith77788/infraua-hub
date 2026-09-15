import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AirActivityStore, BUCKET_MS } from '../../core/analytics/AirActivityStore';

const T0 = 1_700_000_000_000;

/** Fills a store with `n` buckets of `count`, ending one bucket before `endMs`. */
function flat(store: AirActivityStore, count: number, n: number, endMs: number) {
  for (let i = n; i >= 1; i--) store.record(count, new Date(endMs - i * BUCKET_MS));
}

describe('AirActivityStore (in-memory)', () => {
  it('keeps the peak within a bucket, not the sum', () => {
    const s = new AirActivityStore();
    s.record(10, new Date(T0));
    s.record(25, new Date(T0 + 1000));
    const r = s.record(7, new Date(T0 + 2000));
    // Three polls in one bucket → current reflects the peak (25), not 42.
    expect(r.current).toBe(25);
  });

  it('flat activity reads as normal', () => {
    const s = new AirActivityStore();
    const now = T0 + 20 * BUCKET_MS;
    flat(s, 10, 12, now);
    expect(s.surge(new Date(now)).level).toBe('normal');
  });

  it('a sharp rise over baseline is a surge', () => {
    const s = new AirActivityStore();
    const now = T0 + 20 * BUCKET_MS;
    flat(s, 10, 12, now);
    const r = s.record(40, new Date(now));
    expect(r.level).toBe('surge');
    expect(r.baseline).toBe(10);
    expect(r.ratio).toBeGreaterThanOrEqual(3);
  });

  it('a moderate rise is elevated, not a surge', () => {
    const s = new AirActivityStore();
    const now = T0 + 20 * BUCKET_MS;
    flat(s, 10, 12, now);
    expect(s.record(20, new Date(now)).level).toBe('elevated');
  });

  it('too little history stays normal even when current is high', () => {
    const s = new AirActivityStore();
    const now = T0 + 3 * BUCKET_MS;
    flat(s, 10, 2, now);
    expect(s.record(50, new Date(now)).level).toBe('normal');
  });

  it('below the noise floor a surge is not raised', () => {
    const s = new AirActivityStore();
    const now = T0 + 20 * BUCKET_MS;
    flat(s, 1, 12, now);
    expect(s.record(4, new Date(now)).level).toBe('normal');
  });

  it('a stale latest bucket reports current 0', () => {
    const s = new AirActivityStore();
    const stale = T0;
    flat(s, 30, 12, stale);
    const now = stale + 60 * BUCKET_MS;
    expect(s.surge(new Date(now)).current).toBe(0);
  });
});

describe('AirActivityStore (per-oblast)', () => {
  it('names the spiking oblast even when the total looks calm', () => {
    const s = new AirActivityStore();
    const now = T0 + 20 * BUCKET_MS;
    // Baseline: Kharkiv quiet at 2, Lviv quiet at 1, total flat.
    for (let i = 12; i >= 1; i--) {
      s.record(3, new Date(now - i * BUCKET_MS), { Харківська: 2, Львівська: 1 });
    }
    // Now Kharkiv jumps to 12; total also rises but the oblast is the story.
    s.record(13, new Date(now), { Харківська: 12, Львівська: 1 });
    const regions = s.regionSurges(new Date(now));
    expect(regions[0]!.region).toBe('Харківська');
    expect(regions[0]!.level).toBe('surge');
    // A quiet oblast is not news — it is not returned.
    expect(regions.some((r) => r.region === 'Львівська')).toBe(false);
  });

  it('ignores malformed region entries', () => {
    const s = new AirActivityStore();
    // Negative / non-finite counts and empty names are dropped, not stored.
    const r = s.record(5, new Date(T0), { "": 3, Одеська: -1, Київська: 4 } as Record<
      string,
      number
    >);
    expect(r.current).toBe(5);
    // Only Kyiv survived sanitising; but with one sample it stays normal.
    expect(s.regionSurges(new Date(T0))).toHaveLength(0);
  });
});

describe('AirActivityStore (persistence)', () => {
  it('reloads observations from disk and keeps the baseline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-store-'));
    const file = path.join(dir, 'nested', 'air-activity.log');
    const now = T0 + 20 * BUCKET_MS;

    const first = new AirActivityStore(file);
    flat(first, 10, 12, now);
    first.record(40, new Date(now));

    // A fresh instance over the same file sees the whole history.
    const reopened = new AirActivityStore(file);
    const r = reopened.surge(new Date(now));
    expect(reopened.size()).toBe(13);
    expect(r.level).toBe('surge');
    expect(r.baseline).toBe(10);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
