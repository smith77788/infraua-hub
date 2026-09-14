/**
 * Міста для точки людини — щоб радар рахував не «по центру області».
 *
 * Донедавна і кнопки, і текст (`/my Харків`) вміли лише області: точкою ставав
 * обласний центр — орієнтир на десятки кілометрів. Мешканцю Кременчука,
 * Маріуполя чи Нікополя це давало радіус від чужого міста. Тут — вивірений
 * перелік великих міст із координатами, щоб «моя точка» була справді моя.
 *
 * Перелік свідомо курований, а не повний реєстр: сотні сіл у кнопках і в
 * префіксному пошуку лише заважали б. Хто в невеликому пункті — надсилає
 * геолокацію (точніше за будь-який список) або бере найближче місто.
 *
 * Чисті функції й дані — тестуються без мережі.
 */

import { matchOblast } from "./bot-inline";
import { CITIES, type Place } from "./ua-cities";

export type { Place };

export interface MatchedPlace extends Place {
  /** `city` — конкретне місто; `oblast` — центр області (запасний варіант). */
  kind: "city" | "oblast";
}

/** Приводимо до спільного вигляду: регістр, апострофи (’ ʼ ` → '), пробіли. */
function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * Місце за тим, що людина набрала: спершу конкретне місто, потім — область.
 *
 * Місто важливіше за область: хто пише «Кременчук», хоче Кременчук, а не
 * Полтавщину. Точний збіг сильніший за префікс; серед префіксів беремо
 * найкоротшу назву — щоб «нік» дало Нікополь, а не щось довше, що теж на «нік».
 */
export function matchPlace(query: string): MatchedPlace | null {
  const q = norm(query);
  if (q.length < 2) return null;

  const exact = CITIES.find((c) => norm(c.name) === q);
  if (exact) return { ...exact, kind: "city" };

  const prefix = CITIES.filter((c) => norm(c.name).startsWith(q)).sort(
    (a, b) => a.name.length - b.name.length,
  );
  if (prefix[0]) return { ...prefix[0], kind: "city" };

  const oblast = matchOblast(query);
  return oblast ? { ...oblast, kind: "oblast" } : null;
}
