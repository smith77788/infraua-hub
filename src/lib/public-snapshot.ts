/**
 * Публічний знімок повітряної обстановки — щоб радар став ДЖЕРЕЛОМ, а не лише
 * застосунком.
 *
 * Будь-який український сайт, блог чи бот зможе взяти цей JSON і показати живу
 * картину неба — так само, як усі беруть погоду. Це перетворює монітор на
 * інфраструктуру ніші: чим більше вбудувань, тим більше людей бачить попередження.
 *
 * Віддаємо тільки те, що вже й так на публічній мапі: позиція, тип, курс. Жодних
 * внутрішніх полів (id, джерела OSINT, лічильники згадок) — вони ні до чого
 * зовнішньому читачеві й лише плутали б. Координати огрублені до ~100 м: віджету
 * точніше не треба, а зайва точність — це зайва відповідальність.
 *
 * Чиста функція: та сама на вході — та сама на виході, тож її видно в тестах.
 */

import { observedAt, type Threat, type ThreatType } from "./air";

export interface PublicThreat {
  lat: number;
  lon: number;
  type: ThreatType;
  /** Курс у градусах (0=Пн), лише коли він СПОСТЕРЕЖЕНИЙ. Немає — не вигадуємо. */
  heading?: number;
}

export interface PublicAirSnapshot {
  /** Коли знімок сформовано (epoch ms). */
  at: number;
  /**
   * Коли джерело востаннє БАЧИЛО ціль (epoch ms), або `null` на порожньому небі.
   *
   * Окремо від `at`, і це головне поле для того, хто вбудовує наші дані. `at`
   * каже лише, що наш сервер відповів: на збої джерела він свідомо віддає
   * останню відому картину, тож `at` буде свіжим і тоді, коли позначки
   * годинної давності. Без `observedAt` чужий віджет показував би застиглу
   * картину як поточну — і ми були б причиною цієї помилки.
   */
  observedAt: number | null;
  /** Скільки цілей у небі. */
  count: number;
  threats: PublicThreat[];
  source: "OSINT";
  /** Чесне застереження — має їхати разом із даними, куди б їх не вставили. */
  disclaimer: string;
}

const DISCLAIMER =
  "Дані OSINT, не офіційне джерело. Офіційні тривоги й відбій дають Повітряні Сили ЗСУ.";

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Формує публічний знімок із внутрішніх цілей. */
export function publicAirSnapshot(
  threats: readonly Threat[],
  now: number = Date.now(),
): PublicAirSnapshot {
  const list: PublicThreat[] = threats
    .filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lon))
    .map((t) => {
      const type: ThreatType = t.type ?? "unknown";
      const hasCourse = typeof t.heading === "number" && Number.isFinite(t.heading);
      return hasCourse
        ? { lat: round(t.lat), lon: round(t.lon), type, heading: Math.round(t.heading as number) }
        : { lat: round(t.lat), lon: round(t.lon), type };
    });
  return {
    at: now,
    observedAt: observedAt(threats),
    count: list.length,
    threats: list,
    source: "OSINT",
    disclaimer: DISCLAIMER,
  };
}
