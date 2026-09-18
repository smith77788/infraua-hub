/**
 * Ритм загрози — «коли зазвичай прилітає у вашій області».
 *
 * Люди питають не лише «що зараз», а й «чи можна лягати спати». Відповідь на це
 * не в поточній обстановці, а в статистиці: масовані заходи шахедів по кожному
 * регіону мають добовий ритм — десь пік о другій ночі, десь під ранок. Один
 * рядок «у вашій області найгарячіше 02:00–04:00» вартий години на форумах, і
 * його не дає жоден монітор цілей, бо для цього треба ПАМʼЯТАТИ, а не показувати
 * поточний кадр.
 *
 * Тут — накопичення (гістограма за годинами доби на кожну область) і читання
 * (пік, тиша, скільки набрано). Дані плоскі й серіалізовні, щоб лягати стійкою
 * позначкою й переживати редеплой. Порожня історія чесно каже «ще мало даних»,
 * а не вигадує ритм із трьох спостережень.
 *
 * Чиста логіка: ні мережі, ні годинника, крім переданого часу.
 */

/** Гістограма: область → 24 відра (годину київської доби). */
export type RhythmBuckets = Record<string, number[]>;

/** Скільки спостережень треба, щоб узагалі говорити про ритм області. */
export const RHYTHM_MIN_OBSERVATIONS = 12;

function emptyDay(): number[] {
  return new Array<number>(24).fill(0);
}

/**
 * Додає спостереження: у годину `hourKyiv` над `oblast` було `weight` цілей.
 *
 * `weight` — не «одна подія», а кількість цілей: масований захід важить більше
 * за поодиноку розвідку, інакше ритм показував би, коли ХОЧ ЩОСЬ буває, а не
 * коли справді гаряче.
 */
export function accrueRhythm(
  buckets: RhythmBuckets,
  oblast: string,
  hourKyiv: number,
  weight = 1,
): RhythmBuckets {
  if (!oblast || !Number.isFinite(hourKyiv)) return buckets;
  const hour = ((Math.floor(hourKyiv) % 24) + 24) % 24;
  const w = Math.max(0, weight);
  if (w === 0) return buckets;
  const day = buckets[oblast] ? [...buckets[oblast]!] : emptyDay();
  // Захист від битих позначок: масив міг прийти коротшим/довшим.
  while (day.length < 24) day.push(0);
  day[hour] = (day[hour] ?? 0) + w;
  return { ...buckets, [oblast]: day.slice(0, 24) };
}

export interface RhythmSummary {
  oblast: string;
  total: number;
  /** Достатньо даних, щоб довіряти піку. */
  confident: boolean;
  /** Години-пік (до трьох найгарячіших, за спаданням). */
  peakHours: number[];
  /** Найтихіша година доби. */
  quietHour: number | null;
  /** Частка нальотів, що припадає на нічні години 23:00–06:00. */
  nightShare: number;
  /** Готовий рядок для показу, напр. «пік 02:00–04:00». */
  label: string;
}

/** Форматує годину як «02:00». */
function hh(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Чи ніч (23:00–06:59) — той самий поділ, що в решті проєкту. */
function isNightHour(hour: number): boolean {
  return hour >= 23 || hour < 7;
}

/**
 * Читає ритм області: пік, тиша, нічна частка. Без достатньої історії —
 * `confident: false` і чесний рядок замість вигаданого піку.
 */
export function summarizeRhythm(buckets: RhythmBuckets, oblast: string): RhythmSummary {
  const day = buckets[oblast] ?? emptyDay();
  const total = day.reduce((n, x) => n + x, 0);
  const confident = total >= RHYTHM_MIN_OBSERVATIONS;

  if (total === 0) {
    return {
      oblast,
      total: 0,
      confident: false,
      peakHours: [],
      quietHour: null,
      nightShare: 0,
      label: "поки що мало даних для ритму",
    };
  }

  const indexed = day.map((count, hour) => ({ hour, count }));
  const max = Math.max(...day);
  // Пік — усі години в межах 80% від максимуму, до трьох, за спаданням.
  const peakHours = indexed
    .filter((x) => x.count >= max * 0.8 && x.count > 0)
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
    .slice(0, 3)
    .map((x) => x.hour);
  const quiet = indexed.slice().sort((a, b) => a.count - b.count || a.hour - b.hour)[0];
  const nightCount = indexed.reduce((n, x) => (isNightHour(x.hour) ? n + x.count : n), 0);
  const nightShare = total > 0 ? nightCount / total : 0;

  const sortedPeaks = [...peakHours].sort((a, b) => a - b);
  const label = !confident
    ? `ритм формується (${total} спостережень)`
    : sortedPeaks.length >= 2 && sortedPeaks[sortedPeaks.length - 1]! - sortedPeaks[0]! <= 4
      ? `пік ${hh(sortedPeaks[0]!)}–${hh(sortedPeaks[sortedPeaks.length - 1]!)}`
      : `пік близько ${hh(sortedPeaks[0] ?? peakHours[0] ?? 0)}`;

  return {
    oblast,
    total,
    confident,
    peakHours,
    quietHour: quiet ? quiet.hour : null,
    nightShare,
    label,
  };
}

/**
 * Повільне забування: історія важить менше з часом, інакше ритм трирічної
 * давнини перекриє те, як ворог змінив тактику цього місяця. Множник <1
 * застосовується раз на добу до всіх відер.
 */
export function decayRhythm(buckets: RhythmBuckets, factor = 0.97): RhythmBuckets {
  const f = Math.max(0, Math.min(1, factor));
  const out: RhythmBuckets = {};
  for (const [oblast, day] of Object.entries(buckets)) {
    const decayed = day.map((x) => Math.round(x * f * 100) / 100);
    // Область, що згасла в нуль, прибираємо, щоб позначка не пухла вічно.
    if (decayed.some((x) => x > 0.01)) out[oblast] = decayed;
  }
  return out;
}

/**
 * Внесок одного зрізу неба в ритм, нормований на пройдений час.
 *
 * ЧОМУ НЕ ПОТИКОВО. Якби кожен тик додавав однаково, гістограма міряла б не
 * небо, а частоту наших опитувань. Після рестарту, стороннього крона чи
 * ручного `/channel` тиків за ту годину більше — і та сама година набрала б
 * удвічі більше, ніж сусідня з такою самою обстановкою. Ритм показував би наш
 * планувальник.
 *
 * `minutes` — скільки часу минуло з попереднього накопичення; внесок ділиться
 * на `perTickMinutes` (штатний крок), тож штатний тик важить рівно одиницю, а
 * зайвий — рівно стільки, скільки часу справді представляє.
 *
 * Стеля в 15 хвилин обрізає прогалину після рестарту: між двома тиками могло
 * минути пів дня, і зарахувати їх усі в одну годину означало б вигадати наліт,
 * якого ніхто не спостерігав.
 */
export function accrueSnapshotRhythm(
  buckets: RhythmBuckets,
  snapshot: { oblasts: Record<string, Partial<Record<string, number>>> },
  hourKyiv: number,
  minutes: number,
  perTickMinutes = 5,
): RhythmBuckets {
  if (!Number.isFinite(minutes) || minutes <= 0) return buckets;
  if (!Number.isFinite(perTickMinutes) || perTickMinutes <= 0) return buckets;
  const share = Math.min(minutes, MAX_ACCRUAL_MIN) / perTickMinutes;
  let out = buckets;
  for (const [oblast, byType] of Object.entries(snapshot.oblasts)) {
    let n = 0;
    for (const value of Object.values(byType)) {
      // Битий зріз не має ставати нескінченністю у вічній позначці:
      // JSON.parse("1e400") дає Infinity, і воно пережило б будь-який редеплой.
      if (typeof value === "number" && Number.isFinite(value) && value > 0) n += value;
    }
    if (n > 0) out = accrueRhythm(out, oblast, hourKyiv, n * share);
  }
  return out;
}

/** Стеля внеску одного накопичення, хв — обрізає прогалину після рестарту. */
export const MAX_ACCRUAL_MIN = 15;
