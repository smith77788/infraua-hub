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
 * Beyond the total, activity is broken down by oblast: a national count can sit
 * at its usual level while one region spikes, and that region is exactly what a
 * duty officer needs named. Each observation carries the per-oblast counts, and
 * every oblast gets the same baseline treatment as the total.
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
  /** Total active target count reported at that moment. */
  count: number;
  /** Active count per oblast at that moment, when the source gives it. */
  regions?: Record<string, number>;
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

export interface RegionSurge extends SurgeResult {
  region: string;
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

interface Bucket {
  t: number;
  count: number;
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

  /**
   * Records the current activity and returns the total surge assessment.
   *
   * @param count total active-target count
   * @param regions active count per oblast, when known
   */
  record(
    count: number,
    now = new Date(),
    regions?: Record<string, number>,
    opts: SurgeOptions = {},
  ): SurgeResult {
    const safe = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
    const obs: Observation = { t: now.getTime(), count: safe };
    const cleanRegions = sanitizeRegions(regions);
    if (cleanRegions) obs.regions = cleanRegions;
    this.observations.push(obs);
    if (this.filePath) fs.appendFileSync(this.filePath, JSON.stringify(obs) + '\n', 'utf-8');
    return this.surge(now, opts);
  }

  /** Folds one series into per-bucket peaks, oldest first. `pick` reads the value. */
  private bucketsOf(bucketMs: number, pick: (o: Observation) => number | undefined): Bucket[] {
    const peak = new Map<number, number>();
    for (const o of this.observations) {
      const v = pick(o);
      if (v === undefined) continue;
      const b = bucketStart(o.t, bucketMs);
      peak.set(b, Math.max(peak.get(b) ?? 0, v));
    }
    return [...peak.entries()].sort((a, b) => a[0] - b[0]).map(([t, count]) => ({ t, count }));
  }

  private assess(buckets: Bucket[], now: Date, opts: SurgeOptions): SurgeResult {
    const bucketMs = opts.bucketMs ?? BUCKET_MS;
    const baselineMs = opts.baselineMs ?? 6 * 60 * 60 * 1000;
    const minSamples = opts.minSamples ?? 6;
    const floor = opts.floor ?? 6;
    const surgeRatio = opts.surgeRatio ?? 3;
    const elevatedRatio = opts.elevatedRatio ?? 1.8;
    const freshMs = opts.freshMs ?? 2 * bucketMs;

    const nowBucket = bucketStart(now.getTime(), bucketMs);
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

  /** Compares total current activity with this deployment's own baseline. */
  surge(now = new Date(), opts: SurgeOptions = {}): SurgeResult {
    const bucketMs = opts.bucketMs ?? BUCKET_MS;
    return this.assess(
      this.bucketsOf(bucketMs, (o) => o.count),
      now,
      opts,
    );
  }

  /**
   * Per-oblast surge, worst first. Only oblasts with current activity and a
   * non-normal level are returned: a quiet region is not news, and the point of
   * the breakdown is to name the one that is spiking while the total looks calm.
   */
  regionSurges(now = new Date(), opts: SurgeOptions = {}, limit = 6): RegionSurge[] {
    const bucketMs = opts.bucketMs ?? BUCKET_MS;
    const regions = new Set<string>();
    for (const o of this.observations) {
      if (o.regions) for (const r of Object.keys(o.regions)) regions.add(r);
    }
    const out: RegionSurge[] = [];
    for (const region of regions) {
      const s = this.assess(
        this.bucketsOf(bucketMs, (o) => o.regions?.[region]),
        now,
        opts,
      );
      if (s.level !== 'normal') out.push({ region, ...s });
    }
    out.sort((a, b) => b.ratio - a.ratio || b.current - a.current);
    return out.slice(0, limit);
  }

  size(): number {
    return this.observations.length;
  }
}

/** Keeps only finite, non-negative counts under non-empty region names. */
function sanitizeRegions(regions?: Record<string, number>): Record<string, number> | undefined {
  if (!regions || typeof regions !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(regions)) {
    if (name && Number.isFinite(value) && value >= 0) out[name] = Math.round(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
