import * as fs from 'fs';
import * as path from 'path';

/**
 * Persisted history of air-target activity, for surge detection against a
 * baseline that survives restarts and spans days.
 *
 * The console already detects a surge from the browser's own session — but that
 * baseline is per-device and forgets on a cache clear. The question "is the sky
 * busier than normal for this time" needs history that outlives one tab, and on
 * a stateless Worker there is nowhere to keep it. Here there is: the platform
 * runs on a durable volume, so the count of active targets is appended over
 * time and the baseline is computed from what this deployment actually saw.
 *
 * Append-only, newline-delimited, like the audit and snapshot logs: a history
 * rewritten whole on every write is a history one bad flush can lose. Buckets
 * are folded at read time, so a burst of polls inside one bucket keeps its peak
 * rather than inflating the norm with duplicates.
 */

/** Bucket size — activity is folded into 10-minute buckets. */
export const BUCKET_MS = 10 * 60 * 1000;

interface Observation {
  /** Observation time, ms since epoch. */
  t: number;
  /** Active target count reported at that moment. */
  count: number;
}

export type SurgeLevel = 'normal' | 'elevated' | 'surge';

export interface SurgeResult {
  current: number;
  baseline: number;
  ratio: number;
  level: SurgeLevel;
  /** How many prior buckets informed the baseline (below the minimum → normal). */
  samples: number;
  /** ISO time of the newest observation, or null when the store is empty. */
  updatedAt: string | null;
}

export interface SurgeOptions {
  bucketMs?: number;
  /** Baseline window, ms (default 6h). */
  baselineMs?: number;
  /** Minimum prior buckets for a baseline, else level normal (default 6). */
  minSamples?: number;
  /** Noise floor on the current count — below this we do not raise (default 6). */
  floor?: number;
  /** Ratio for level "surge" (default 3). */
  surgeRatio?: number;
  /** Ratio for level "elevated" (default 1.8). */
  elevatedRatio?: number;
  /** How fresh the latest bucket must be, ms (default 2 × bucket). */
  freshMs?: number;
}

function bucketStart(tMs: number, bucketMs: number): number {
  return Math.floor(tMs / bucketMs) * bucketMs;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

export class AirActivityStore {
  private observations: Observation[] = [];

  constructor(private readonly filePath?: string) {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      this.observations = fs
        .readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Observation)
        .filter((o) => typeof o.t === 'number' && typeof o.count === 'number');
    }
  }

  /** Records the current active-target count and returns the surge assessment. */
  record(count: number, now = new Date(), opts: SurgeOptions = {}): SurgeResult {
    const safe = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
    const obs: Observation = { t: now.getTime(), count: safe };
    this.observations.push(obs);
    if (this.filePath) fs.appendFileSync(this.filePath, JSON.stringify(obs) + '\n', 'utf-8');
    return this.surge(now, opts);
  }

  /** Folds observations into per-bucket peaks, oldest first. */
  private buckets(bucketMs: number): { t: number; count: number }[] {
    const peak = new Map<number, number>();
    for (const o of this.observations) {
      const b = bucketStart(o.t, bucketMs);
      peak.set(b, Math.max(peak.get(b) ?? 0, o.count));
    }
    return [...peak.entries()].sort((a, b) => a[0] - b[0]).map(([t, count]) => ({ t, count }));
  }

  /** Compares current activity with this deployment's own baseline. */
  surge(now = new Date(), opts: SurgeOptions = {}): SurgeResult {
    const bucketMs = opts.bucketMs ?? BUCKET_MS;
    const baselineMs = opts.baselineMs ?? 6 * 60 * 60 * 1000;
    const minSamples = opts.minSamples ?? 6;
    const floor = opts.floor ?? 6;
    const surgeRatio = opts.surgeRatio ?? 3;
    const elevatedRatio = opts.elevatedRatio ?? 1.8;
    const freshMs = opts.freshMs ?? 2 * bucketMs;

    const buckets = this.buckets(bucketMs);
    const nowMs = now.getTime();
    const nowBucket = bucketStart(nowMs, bucketMs);
    const latest = buckets[buckets.length - 1];
    const current = latest && nowBucket - latest.t <= freshMs ? latest.count : 0;

    const from = nowBucket - baselineMs;
    const prior = buckets.filter((b) => b.t >= from && b.t < nowBucket).map((b) => b.count);
    const baseline = median(prior);
    const samples = prior.length;

    const ratio = baseline > 0 ? current / baseline : 0;
    let level: SurgeLevel = 'normal';
    if (samples >= minSamples && current >= floor && baseline > 0) {
      if (ratio >= surgeRatio) level = 'surge';
      else if (ratio >= elevatedRatio) level = 'elevated';
    }

    return {
      current,
      baseline: Math.round(baseline * 10) / 10,
      ratio: Math.round(ratio * 100) / 100,
      level,
      samples,
      updatedAt: latest ? new Date(latest.t).toISOString() : null,
    };
  }

  size(): number {
    return this.observations.length;
  }
}
