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
 * Разом із позицією обовʼязково їде те, БЕЗ ЧОГО ВОНА БРЕШЕ: розкид у
 * кілометрах і вік спостереження. Крапка без цих двох чисел — твердження
 * «ціль тут і зараз», якого дані не підтверджують, а чуже вбудування не має
 * як про це дізнатись.
 *
 * Чиста функція: та сама на вході — та сама на виході, тож її видно в тестах.
 */

import { observedAt, type Threat, type ThreatType } from "./air";
import { fixAgeMs } from "./position-age";
import { courseIsObserved, EMPTY_QUALITY } from "./threat-quality";

export interface PublicThreat {
  lat: number;
  lon: number;
  type: ThreatType;
  /**
   * Курс у градусах (0=Пн) — ЛИШЕ спостережений.
   *
   * Обіцянка була тут від початку, а перевірки не було: код публікував будь-яке
   * `heading`, і джерело позначало більшість курсів як припущені. Заміряно на
   * живій видачі: 17 із 19 опублікованих курсів (89%) були здогадками,
   * виданими за спостереження. Чужий віджет малює те, що бачить у полі
   * `heading`, тож наша похибка їхала в кожне вбудування.
   */
  heading?: number;
  /**
   * Курс, який джерело саме називає ПРИПУЩЕНИМ.
   *
   * Окремим іменем навмисно: інформація корисна, але той, хто малює стрілку не
   * думаючи, візьме `heading` — і не намалює здогадку як факт. Хто хоче
   * показати припущення, зробить це свідомо.
   */
  presumedHeading?: number;
  /**
   * Розкид позиції, км: наскільки ціль може бути не там, де крапка.
   *
   * Без цього поля будь-яке вбудування показує крапку — тобто твердження про
   * точність, якого немає. У живій видачі розкид від 2 до 25 км.
   */
  uncertaintyKm?: number;
  /**
   * Скільки секунд минуло, відколи позицію СПОСТЕРЕЖЕНО.
   *
   * Заміряно: медіана 205 с, максимум 674 с. На типовій швидкості шахеда це
   * від 10 до 34 км польоту після фікса. Знімок без цього числа читається як
   * «ось де воно зараз», а це неправда для кожної позначки.
   */
  ageSec?: number;
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
      const q = t.quality ?? EMPTY_QUALITY;
      const hasCourse = typeof t.heading === "number" && Number.isFinite(t.heading);
      const course = hasCourse ? Math.round(t.heading as number) : null;
      const observed = courseIsObserved(q);
      const age = fixAgeMs(t, now);
      return {
        lat: round(t.lat),
        lon: round(t.lon),
        type,
        ...(course !== null && observed ? { heading: course } : {}),
        ...(course !== null && !observed ? { presumedHeading: course } : {}),
        ...(q.uncertaintyKm !== null ? { uncertaintyKm: q.uncertaintyKm } : {}),
        ...(age !== null ? { ageSec: Math.round(age / 1000) } : {}),
      };
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
