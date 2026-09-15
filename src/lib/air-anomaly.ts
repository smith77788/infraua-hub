/**
 * Виявлення сплеску повітряної активності відносно власної норми.
 *
 * Карта показує, скільки цілей у небі ЗАРАЗ. Але «40 цілей» саме по собі нічого
 * не каже: у розпал масованої атаки це норма, а тихої ночі — це початок чогось.
 * Відповідь дає лише порівняння з тим, що звично для цього ж часу: різкий ріст
 * над власною базовою лінією — сигнал, що активність ненормальна.
 *
 * Модуль чистий і безстановий: приймає накопичену історію та поточне значення,
 * повертає рівень. Історію накопичує той, хто викликає (у браузері — між
 * опитуваннями, з памʼяттю на пристрої; на платформі — на постійному томі).
 * Так один і той самий розрахунок працює і на клієнті, і на сервері.
 */

/** Розмір кошика часу — активність згортається у 10-хвилинні відра. */
export const BUCKET_MS = 10 * 60 * 1000;

export interface ActivityBucket {
  /** Початок відра, мс від епохи (кратний BUCKET_MS). */
  t: number;
  /** Пікова кількість активних цілей у межах відра. */
  count: number;
}

export type SurgeLevel = "normal" | "elevated" | "surge";

export interface SurgeResult {
  /** Поточна кількість (останнє свіже відро). */
  current: number;
  /** Базова лінія — медіана попередніх відер у вікні. */
  baseline: number;
  /** Відношення поточного до базового (0, якщо базового ще нема). */
  ratio: number;
  level: SurgeLevel;
  /** Скільки відер сформували базову лінію (менше мінімуму → рівень normal). */
  samples: number;
}

export interface AddOptions {
  bucketMs?: number;
  /** Скільки історії тримати, мс (старше — відкидаємо). За замовч. 7 діб. */
  maxAgeMs?: number;
}

/** Початок відра, якому належить момент `tMs`. */
export function bucketStart(tMs: number, bucketMs: number = BUCKET_MS): number {
  return Math.floor(tMs / bucketMs) * bucketMs;
}

/**
 * Додає спостереження до історії. У межах одного відра лишається ПІК (max):
 * опитування раз на 30 с дало б багато точок в одному відрі, і сума роздула б
 * норму, тоді як пік чесно каже «скільки було видно щонайбільше».
 */
export function addObservation(
  buckets: ActivityBucket[],
  count: number,
  atMs: number,
  opts: AddOptions = {},
): ActivityBucket[] {
  const bucketMs = opts.bucketMs ?? BUCKET_MS;
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const t = bucketStart(atMs, bucketMs);
  const cutoff = t - maxAgeMs;

  const next = new Map<number, number>();
  for (const b of buckets) {
    if (b.t < cutoff) continue; // прибираємо застаріле
    next.set(b.t, b.count);
  }
  next.set(t, Math.max(next.get(t) ?? 0, count));

  return [...next.entries()].sort((a, b) => a[0] - b[0]).map(([bt, c]) => ({ t: bt, count: c }));
}

export interface SurgeOptions {
  bucketMs?: number;
  /** Вікно базової лінії, мс (за замовч. 6 год). */
  baselineMs?: number;
  /** Мінімум відер для базової лінії, інакше рівень normal. За замовч. 6. */
  minSamples?: number;
  /** Нижній поріг поточного значення — менше цього не тривожимо. За замовч. 6. */
  floor?: number;
  /** Відношення для рівня «сплеск». За замовч. 3. */
  surgeRatio?: number;
  /** Відношення для рівня «підвищено». За замовч. 1.8. */
  elevatedRatio?: number;
  /** Наскільки свіжим має бути останнє відро, мс. За замовч. 2 × bucket. */
  freshMs?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

/**
 * Порівнює поточну активність із власною нормою. Базова лінія — медіана
 * попередніх відер у вікні (без поточного); рівень — за відношенням до неї.
 * Поки історії замало або значення нижче порогу шуму — рівень `normal`.
 */
export function detectSurge(
  buckets: ActivityBucket[],
  nowMs: number,
  opts: SurgeOptions = {},
): SurgeResult {
  const bucketMs = opts.bucketMs ?? BUCKET_MS;
  const baselineMs = opts.baselineMs ?? 6 * 60 * 60 * 1000;
  const minSamples = opts.minSamples ?? 6;
  const floor = opts.floor ?? 6;
  const surgeRatio = opts.surgeRatio ?? 3;
  const elevatedRatio = opts.elevatedRatio ?? 1.8;
  const freshMs = opts.freshMs ?? 2 * bucketMs;

  const nowBucket = bucketStart(nowMs, bucketMs);
  const latest = buckets[buckets.length - 1];
  const current = latest && nowBucket - latest.t <= freshMs ? latest.count : 0;

  // Базова лінія — попередні відра у вікні, поточне виключаємо.
  const from = nowBucket - baselineMs;
  const prior = buckets.filter((b) => b.t >= from && b.t < nowBucket).map((b) => b.count);
  const baseline = median(prior);
  const samples = prior.length;

  const ratio = baseline > 0 ? current / baseline : 0;
  let level: SurgeLevel = "normal";
  if (samples >= minSamples && current >= floor && baseline > 0) {
    if (ratio >= surgeRatio) level = "surge";
    else if (ratio >= elevatedRatio) level = "elevated";
  }

  return {
    current,
    baseline: Math.round(baseline * 10) / 10,
    ratio: Math.round(ratio * 100) / 100,
    level,
    samples,
  };
}
