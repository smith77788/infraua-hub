import { normalizeThreatType, type Threat, type ThreatType } from "./air";
import { SPEED_KMH } from "./threat-eta";

/**
 * Яку швидкість цілі кожного типу ЗАМІРЯНО — а не взято з довідки.
 *
 * ## Навіщо
 *
 * Швидкість реактивних ми беремо з відкритих оцінок, а вони розходяться
 * вдвічі: «Герань-3» — 550–600 км/год за ГУР, 300–370 для серії з двигуном
 * Telefly JT80; «Бандероль» — «до 500». Власних замірів із треків каналів
 * набралось два (271 і 288 км/год, 22.10) — замало, щоб правити довідку.
 *
 * Нептун для частини цілей віддає заміряну ним швидкість (`velocity.speedKmh`).
 * Тип у нас точніший за його (реактивність і «Бандероль» — з каналів, див.
 * `jet-sightings`), тож пара «наш тип + його швидкість» і є вимір, якого бракує.
 *
 * ## Правила
 *
 * - Одна ціль — одна точка вибірки: остання заміряна швидкість цілі. Інакше
 *   ціль, що висіла пів години, важила б у медіані в сотні разів більше за
 *   ту, що пролетіла за хвилину.
 * - Тип — останній відомий для цілі: якщо канали вже назвали її реактивною,
 *   рахуємо в реактивні.
 * - Вікно — `WINDOW_MS`: тиждень, бо реактивні летять не щоночі, а
 *   модифікації змінюються.
 * - Лише заміряне: ціль без `speedKmh` у вибірку не потрапляє.
 */

export const WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Скільки цілей тримаємо — вистачає на тиждень масованих атак. */
const MAX_ENTRIES = 5000;
/** Відкидаємо очевидні викиди виміру: стоїть або «летить» як балістика. */
const MIN_KMH = 20;
const MAX_KMH = 1200;

interface Entry {
  type: ThreatType;
  kmh: number;
  at: number;
}

export interface SpeedStat {
  /** Скільки різних цілей. */
  n: number;
  medianKmh: number;
  p25Kmh: number;
  p75Kmh: number;
  /** Що в довідці (`SPEED_KMH`) — для порівняння поруч. */
  referenceKmh: number;
}

export class SpeedLedger {
  private entries = new Map<string, Entry>();

  observe(threats: readonly Threat[], now: number): void {
    for (const t of threats) {
      // Сирий замір джерела, навіть відкинутий для руху: вибірка — про джерело.
      const kmh = t.quality?.reportedSpeedKmh ?? t.quality?.speedKmh;
      if (typeof kmh !== "number" || !(kmh >= MIN_KMH && kmh <= MAX_KMH)) continue;
      if (!t.id) continue;
      this.entries.delete(t.id); // перевставляємо — порядок Map = свіжість
      this.entries.set(t.id, { type: t.type ?? "unknown", kmh, at: now });
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Медіана й міжквартильний розмах за типами; типи без замірів не показуємо. */
  summary(now: number): Partial<Record<ThreatType, SpeedStat>> {
    const by = new Map<ThreatType, number[]>();
    for (const e of this.entries.values()) {
      if (now - e.at > WINDOW_MS) continue;
      const list = by.get(e.type) ?? [];
      list.push(e.kmh);
      by.set(e.type, list);
    }
    const out: Partial<Record<ThreatType, SpeedStat>> = {};
    for (const [type, list] of by) {
      list.sort((a, b) => a - b);
      out[type] = {
        n: list.length,
        medianKmh: Math.round(quantile(list, 0.5)),
        p25Kmh: Math.round(quantile(list, 0.25)),
        p75Kmh: Math.round(quantile(list, 0.75)),
        referenceKmh: SPEED_KMH[type],
      };
    }
    return out;
  }

  toState(): [string, Entry][] {
    return [...this.entries];
  }

  static fromState(raw: unknown, now: number): SpeedLedger {
    const l = new SpeedLedger();
    if (!Array.isArray(raw)) return l;
    for (const item of raw) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      const e = item[1] as Partial<Entry> | undefined;
      if (
        !e ||
        typeof e.type !== "string" ||
        typeof e.kmh !== "number" ||
        typeof e.at !== "number" ||
        now - e.at > WINDOW_MS
      ) {
        continue;
      }
      l.entries.set(item[0], { type: normalizeThreatType(e.type), kmh: e.kmh, at: e.at });
    }
    return l;
  }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
