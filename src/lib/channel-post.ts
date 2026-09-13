/**
 * Автопост у Telegram-канал «людською» мовою моніторів повітряної обстановки
 * (стиль «Ванька»): не сухе «зафіксовано рух БпЛА», а «10 мопедів південніше
 * Шостки, курсом на/через Мену».
 *
 * Навіщо окремим модулем і чистою функцією. Канал веде не людина, а система:
 * вона щоразу бере ті самі дані, що на карті (getThreats), і сама складає
 * пост. Щоб цьому можна було вірити й це можна було перевірити тестами,
 * генерація тексту не торкається ні мережі, ні годинника — лише вхідні цілі.
 *
 * Регістр — російськомовний, як у референсних каналів («мопед», «может быть
 * громко», «курсом на/через»), бо саме такий стиль просив користувач. Уся
 * лексика зібрана тут, в одному місці, а не розсипана по коду.
 *
 * Дедуп. Ситуація в небі змінюється повільно; без дедупу канал спамив би той
 * самий пост щохвилини. Тому разом із текстом повертається `signature` —
 * стабільний відбиток згрупованої картини. Той, хто постить, порівнює його з
 * останнім надісланим і мовчить, якщо нічого не змінилось.
 */

import type { Threat, ThreatType } from "./air";
import { OBLASTS } from "./alerts";
import { distanceKm } from "./infra-types";
import { angularDiff, bearingDeg } from "./threat-eta";

// Іменник цілі в «ванёк»-регістрі (однина).
const TYPE_WORD: Record<ThreatType, string> = {
  shahed: "мопед",
  reactive: "реактивный мопед",
  cruise: "крылатая",
  missile: "ракета",
  ballistic: "баллистика",
  kab: "КАБ",
  recon: "разведчик",
  aircraft: "борт",
  unknown: "цель",
};

// Груба множина для російської: 1 мопед / 2 мопеда / 5 мопедов.
function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

const TYPE_PLURAL: Record<ThreatType, [string, string, string]> = {
  shahed: ["мопед", "мопеда", "мопедов"],
  reactive: ["реактивный мопед", "реактивных мопеда", "реактивных мопедов"],
  cruise: ["крылатая", "крылатые", "крылатых"],
  missile: ["ракета", "ракеты", "ракет"],
  ballistic: ["баллистическая цель", "баллистические цели", "баллистических целей"],
  kab: ["КАБ", "КАБа", "КАБов"],
  recon: ["разведчик", "разведчика", "разведчиков"],
  aircraft: ["борт", "борта", "бортов"],
  unknown: ["цель", "цели", "целей"],
};

function typePlural(type: ThreatType, n: number): string {
  const [one, few, many] = TYPE_PLURAL[type];
  return plural(n, one, few, many);
}

// Румб курсу «ванёк»-мовою: «курсом на северо-запад».
const COURSE_8 = [
  "на север",
  "на северо-восток",
  "на восток",
  "на юго-восток",
  "на юг",
  "на юго-запад",
  "на запад",
  "на северо-запад",
];
function coursePhrase(heading: number | undefined): string | null {
  if (typeof heading !== "number" || !Number.isFinite(heading)) return null;
  return COURSE_8[Math.round((((heading % 360) + 360) % 360) / 45) % 8]!;
}

interface CityRef {
  name: string;
  lat: number;
  lon: number;
}

// Орієнтири для «может быть громко в X»: обласні центри (публічні координати).
const CITY_REFS: CityRef[] = Object.values(OBLASTS)
  .filter((o, i, arr) => arr.findIndex((x) => x.code === o.code) === i)
  .map((o) => ({ name: o.name, lat: o.lat, lon: o.lon }));

/** Область цілі — найближчий обласний центр (для групування). */
export function oblastOf(lat: number, lon: number): string {
  let best = CITY_REFS[0]!;
  let bestD = Infinity;
  for (const c of CITY_REFS) {
    const d = distanceKm({ lat, lon }, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best.name;
}

/**
 * Чи йде ціль на місто поблизу — тоді «может быть громко в X».
 * Місто в межах `nearKm` і курс у секторі ±`sectorDeg` на нього.
 */
function loudCity(t: Threat, nearKm = 60, sectorDeg = 40): string | null {
  if (typeof t.heading !== "number") return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of CITY_REFS) {
    const d = distanceKm(t, c);
    if (d > nearKm || d < 3) continue;
    const brg = bearingDeg(t, c);
    if (angularDiff(brg, t.heading) <= sectorDeg && d < bestD) {
      bestD = d;
      best = c.name;
    }
  }
  return best;
}

export interface ChannelPost {
  text: string;
  /** Стабільний відбиток картини для дедупу. */
  signature: string;
  /** Скільки цілей увійшло — для рішення «постити чи ні». */
  targets: number;
}

interface Group {
  oblast: string;
  byType: Map<ThreatType, number>;
  loud: Set<string>;
  courses: Map<ThreatType, string>;
}

/**
 * Складає пост каналу з поточних цілей. `null` — постити нічого (небо чисте):
 * канал у стилі «Ванька» не пише «целей нет» щохвилини.
 */
export function renderChannelPost(threats: readonly Threat[]): ChannelPost | null {
  if (!threats.length) return null;

  const groups = new Map<string, Group>();
  for (const t of threats) {
    const type: ThreatType = t.type ?? "unknown";
    const oblast = oblastOf(t.lat, t.lon);
    let g = groups.get(oblast);
    if (!g) {
      g = { oblast, byType: new Map(), loud: new Set(), courses: new Map() };
      groups.set(oblast, g);
    }
    g.byType.set(type, (g.byType.get(type) ?? 0) + Math.max(1, t.count));
    const course = coursePhrase(t.heading);
    if (course && !g.courses.has(type)) g.courses.set(type, course);
    const loud = loudCity(t);
    if (loud) g.loud.add(loud);
  }

  // Найгарячіші області — де більше цілей — вище.
  const ordered = [...groups.values()].sort(
    (a, b) => total(b.byType) - total(a.byType) || a.oblast.localeCompare(b.oblast),
  );

  const lines: string[] = ["<b>общая по воздуху:</b>", ""];
  const sigParts: string[] = [];
  for (const g of ordered) {
    const parts: string[] = [];
    for (const [type, n] of [...g.byType.entries()].sort((a, b) => b[1] - a[1])) {
      const course = g.courses.get(type);
      parts.push(`${n} ${typePlural(type, n)}${course ? ` курсом ${course}` : ""}`);
      sigParts.push(`${g.oblast}:${type}:${n}`);
    }
    let line = `${g.oblast}: ${parts.join(", ")}`;
    // Без прийменника, щоб уникнути відмінка: назви в даних — у називному
    // («Харківщина», «Запоріжжя»), і «громко в Запоріжжя» різало б слух.
    if (g.loud.size) line += ` — может быть громко: ${[...g.loud].join(", ")}!`;
    lines.push(line);
  }

  lines.push("");
  lines.push("<i>по данным OSINT · берегите себя</i>");

  return {
    text: lines.join("\n"),
    signature: sigParts.sort().join("|"),
    targets: threats.reduce((n, t) => n + Math.max(1, t.count), 0),
  };
}

function total(m: Map<ThreatType, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
