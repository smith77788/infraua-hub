/**
 * Вік даних.
 *
 * Дані про інфраструктуру старіють мовчки: карта з учорашніми обʼєктами і
 * карта, оновлена хвилину тому, виглядають однаково. Для подій це критично —
 * пожежа тримісячної давності на екрані поруч зі свіжою читається як
 * поточна обстановка.
 */

export type Freshness = "fresh" | "aging" | "stale" | "unknown";

export interface AgeInfo {
  freshness: Freshness;
  /** Вік у хвилинах; `null`, якщо часу немає. */
  minutes: number | null;
  label: string;
}

function humanAge(minutes: number): string {
  if (minutes < 1) return "щойно";
  if (minutes < 60) return `${Math.round(minutes)} хв тому`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} год тому`;
  return `${Math.round(hours / 24)} дн тому`;
}

/**
 * `agingAfter` і `staleAfter` — у хвилинах, і задаються викликачем, бо
 * «застаріло» означає різне для різних джерел: перелік підстанцій не
 * змінюється роками, повітряна тривога протухає за хвилини.
 */
export function ageOf(
  timestamp: string | null | undefined,
  agingAfter: number,
  staleAfter: number,
  now: number = Date.now(),
): AgeInfo {
  if (!timestamp) return { freshness: "unknown", minutes: null, label: "час невідомий" };
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) {
    return { freshness: "unknown", minutes: null, label: "час невідомий" };
  }

  // Час у майбутньому — це збій джерела, а не свіжість; вважаємо невідомим,
  // щоб не показувати «щойно» для явно битого значення.
  const minutes = (now - parsed) / 60_000;
  if (minutes < -5) return { freshness: "unknown", minutes: null, label: "час невідомий" };

  const clamped = Math.max(0, minutes);
  const freshness: Freshness =
    clamped >= staleAfter ? "stale" : clamped >= agingAfter ? "aging" : "fresh";
  return { freshness, minutes: clamped, label: humanAge(clamped) };
}

/** Пороги за джерелом — задокументовані, а не розсипані по компонентах. */
export const FRESHNESS_THRESHOLDS = {
  /** Перелік обʼєктів: змінюється роками, але старший за добу вже не «живий». */
  facilities: { aging: 60, stale: 24 * 60 },
  /** Події: доба — уже минуле, три доби — історія. */
  events: { aging: 24 * 60, stale: 72 * 60 },
} as const;
