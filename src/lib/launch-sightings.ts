import { classifyThreatType, type ThreatType } from "./air";
import { distanceKm } from "./infra-types";
import type { ChannelMessage } from "./jet-sightings";
import { SPEED_KMH } from "./threat-eta";
import { UA_OUTLINE } from "./ua-outline";

/**
 * Пуски — ще на ТІЙ території: звідки летить і куди вже могло долетіти.
 *
 * ## Навіщо
 *
 * Нептун і наш радар бачать ціль, коли про неї пишуть спостерігачі в Україні.
 * Але про пуск відомо раніше: монітори пишуть «Відмічено пуски: •
 * Приморсько-Ахтарськ — 4 групи • ТО Крим — 2 групи (реактивні)», «Пуск
 * реактивних з Орла, 6 груп» — часто переказуючи саме російські джерела.
 * Заміряно на живих превʼю каналів (2026-10-20): такі повідомлення є, свіжі, з
 * точним часом. Між пуском і першою позначкою в Україні — десятки хвилин, і
 * досі ми їх не використовували.
 *
 * ## Правило розпізнавання
 *
 * Пуск = дієслово пуску («пуск», «запуск», «зліт», «взлёт», «старт») І назва
 * відомого району пусків з довідника нижче — в одному повідомленні. Друга
 * умова відсіює шум, знайдений у тих самих превʼю: «Реактивний БпЛА вилетів в
 * напрямку Лельчиці (Білорусь)» — це наша ціль, що виходить, а не пуск;
 * «стартувало голосування» — не про небо. Розуміє й український, і
 * російський текст: щоб російські канали можна було просто додати до
 * переліку джерел.
 *
 * ## Чого НЕ стверджуємо
 *
 * Точки пуску ми не знаємо: координата — центр відомого населеного пункту,
 * і в інтерфейсі це «район», а не точка. Напрямку польоту з такого
 * повідомлення теж не видно — тому замість вигаданої лінії малюємо те, що
 * знаємо напевно: як далеко перші з цієї серії могли долетіти за час від
 * пуску (швидкість типу × час) — дугою в бік України.
 */

export interface LaunchSite {
  key: string;
  /** Як підписати на карті — район, не точка. */
  label: string;
  lat: number;
  lon: number;
  /** Назва в тексті: українські й російські форми. */
  re: RegExp;
  /**
   * Окупована територія України (Крим): «до кордону» тут не має сенсу — контур
   * країни її включає, і число вийшло б «уже перетнули» про те, що ніде не
   * летіло. Для таких районів час до кордону не рахуємо.
   */
  occupied?: boolean;
}

const L = "а-яіїєґё";
const W = (body: string) => new RegExp(`(?<![${L}])(?:${body})`, "i");

/*
 * Довідник районів пусків. Координати — центри населених пунктів (відомі
 * загальнодоступні координати міст), а не позиції пускових установок; саме
 * тому підпис — «район». Неоднозначні райони (Каспій, Чорне море) свідомо не
 * внесено: вони займають сотні кілометрів, і точка там вигадувала б знання.
 */
export const LAUNCH_SITES: readonly LaunchSite[] = [
  {
    key: "primorsko",
    label: "Приморсько-Ахтарськ",
    lat: 46.04,
    lon: 38.17,
    re: W("приморськ[а-яії]*[- ]?ахтарськ|приморско[- ]?ахтарск"),
  },
  {
    key: "chauda",
    label: "мис Чауда (Крим)",
    lat: 45.0,
    lon: 35.84,
    re: W("чауд"),
    occupied: true,
  },
  {
    key: "crimea",
    label: "Крим (район не уточнено)",
    lat: 45.3,
    lon: 34.4,
    re: W("крим(?![а-яіїєґё])|криму|крым"),
    occupied: true,
  },
  { key: "kursk", label: "Курськ", lat: 51.73, lon: 36.19, re: W("курськ|курск|курщин") },
  { key: "bryansk", label: "Брянськ", lat: 53.24, lon: 34.36, re: W("брянськ|брянск|брянщин") },
  { key: "navlya", label: "Навля (Брянщина)", lat: 52.83, lon: 34.5, re: W("навл[яіиеюі]") },
  {
    key: "orel",
    label: "Орел",
    lat: 52.97,
    lon: 36.07,
    re: W("орла(?![а-яіїєґё])|орел(?![а-яіїєґё])|орлі(?![а-яіїєґё])|орловськ|орловск"),
  },
  { key: "shatalovo", label: "Шаталово", lat: 54.37, lon: 32.47, re: W("шаталов") },
  { key: "millerovo", label: "Міллерово", lat: 48.92, lon: 40.4, re: W("міллеров|миллеров") },
  { key: "yeysk", label: "Єйськ", lat: 46.71, lon: 38.27, re: W("єйськ|ейск") },
  { key: "taganrog", label: "Таганрог", lat: 47.22, lon: 38.9, re: W("таганрог") },
  { key: "belgorod", label: "Бєлгород", lat: 50.6, lon: 36.59, re: W("бєлгород|белгород") },
  { key: "voronezh", label: "Воронеж", lat: 51.67, lon: 39.18, re: W("воронеж") },
  { key: "rostov", label: "Ростов", lat: 47.23, lon: 39.72, re: W("ростов") },
  { key: "engels", label: "Енгельс", lat: 51.48, lon: 46.2, re: W("енгельс|энгельс") },
  {
    key: "olenya",
    label: "Оленья (Мурманщина)",
    lat: 68.15,
    lon: 33.46,
    re: W("олень[яї]|оленегорськ|оленегорск"),
  },
  { key: "mozdok", label: "Моздок", lat: 43.74, lon: 44.65, re: W("моздок") },
];

const LAUNCH_VERB = W("пуск|запуск|відмічено пуск|зл[іе]т|взл[её]т|старт");

/** Скільки часу пуск ще цікавий: далі ці цілі вже давно в небі України. */
export const LAUNCH_WINDOW_MS = 3 * 60 * 60_000;

export interface LaunchSighting {
  key: string;
  label: string;
  lat: number;
  lon: number;
  /** Найраніша й найпізніша згадка у вікні, мс. */
  firstAt: number;
  lastAt: number;
  /** Тип за текстом (`unknown`, якщо текст не каже). */
  type: ThreatType;
  /** Скільки груп назвали канали, якщо назвали. */
  groups: number | null;
  /** Скільки повідомлень про цей район. */
  mentions: number;
  /** Район на окупованій території України — див. `LaunchSite.occupied`. */
  occupied: boolean;
}

/** Тип за текстом рядка: «Пуск реактивних з Орла» — без слова «БпЛА», але підтип названо. */
function typeOf(text: string): ThreatType {
  if (/реактивн/i.test(text)) return "reactive";
  // Загальний класифікатор читає «пуск» як ознаку АВІАЦІЇ (пуск із літака) —
  // і кожне повідомлення про пуск ставало «літаком». Тут дієслово пуску вже
  // відоме й нічого не каже про тип, тож прибираємо його перед класифікацією.
  return classifyThreatType(text.replace(new RegExp(LAUNCH_VERB.source, "gi"), " "));
}

/**
 * Тип за ВСІМ повідомленням — лише коли рядок району сам типу не каже.
 *
 * Змішане повідомлення («типу Shahed та реактивних БпЛА: • Приморсько-Ахтарськ
 * — 4 групи • ТО Крим — 2 групи (реактивні)») не має робити реактивним
 * рядок, де підтипу немає: у таких переліках реактивні позначають явно, як
 * тут. Тож змішане → поршневий «Шахед».
 */
function messageTypeOf(text: string): ThreatType {
  const jet = /реактивн/i.test(text);
  const piston = /shahed|шахед|ударн|герань|мопед/i.test(text);
  if (jet && piston) return "shahed";
  return typeOf(text);
}

/** Конкретні кримські райони: якщо названо їх, загальний «Крим» не додаємо. */
const CRIMEA_SPECIFIC = new Set(["chauda"]);

/** Пуски з повідомлень каналів за останні `LAUNCH_WINDOW_MS`, за районами. */
export function launchSightings(
  messages: readonly ChannelMessage[],
  now: number,
): LaunchSighting[] {
  const out = new Map<string, LaunchSighting>();
  for (const m of messages) {
    if (!(m.at <= now && now - m.at <= LAUNCH_WINDOW_MS)) continue;
    if (!LAUNCH_VERB.test(m.text)) continue;
    // Перелік пусків часто одним повідомленням: «• Приморсько-Ахтарськ — 4
    // групи • ТО Крим — 2 групи (реактивні)» — тип і кількість беремо з того
    // самого рядка, що й район.
    const segments = m.text.split(/•|\n|;/);
    for (const site of LAUNCH_SITES) {
      const seg = segments.find((s) => site.re.test(s));
      if (!seg) continue;
      if (
        site.key === "crimea" &&
        LAUNCH_SITES.some((o) => CRIMEA_SPECIFIC.has(o.key) && o.re.test(seg))
      )
        continue;
      const groups = Number(seg.match(/(\d+)\s*груп/i)?.[1] ?? Number.NaN);
      const segType = typeOf(seg);
      const type = segType !== "unknown" ? segType : messageTypeOf(m.text);
      const prev = out.get(site.key);
      if (!prev) {
        out.set(site.key, {
          key: site.key,
          label: site.label,
          lat: site.lat,
          lon: site.lon,
          firstAt: m.at,
          lastAt: m.at,
          type,
          groups: Number.isFinite(groups) ? groups : null,
          mentions: 1,
          occupied: site.occupied === true,
        });
      } else {
        prev.firstAt = Math.min(prev.firstAt, m.at);
        prev.lastAt = Math.max(prev.lastAt, m.at);
        prev.mentions++;
        if (prev.type === "unknown") prev.type = type;
        if (Number.isFinite(groups)) prev.groups = Math.max(prev.groups ?? 0, groups);
      }
    }
  }
  return [...out.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** Відстань від району пуску до кордону України (найближча вершина контуру), км. */
export function borderKm(site: { lat: number; lon: number }): number {
  let best = Number.POSITIVE_INFINITY;
  for (const [lat, lon] of UA_OUTLINE) best = Math.min(best, distanceKm(site, { lat, lon }));
  return best;
}

export interface LaunchReach {
  /** Як далеко перші з серії могли долетіти зараз, км (0 — швидкість невідома). */
  reachKm: number;
  /** Хвилин до кордону України; 0 — уже могли перетнути; `null` — швидкість невідома. */
  toBorderMin: number | null;
  borderKm: number;
}

/**
 * Скільки пролетіли й скільки до кордону. Швидкість — найімовірніша для типу
 * (`SPEED_KMH`); для невідомого типу оцінки не даємо: дуга на швидкості
 * «чогось» була б вигадкою.
 */
export function launchReach(s: LaunchSighting, now: number): LaunchReach {
  const b = Math.round(borderKm(s));
  if (s.type === "unknown" || s.type === "aircraft")
    return { reachKm: 0, toBorderMin: null, borderKm: b };
  const v = SPEED_KMH[s.type];
  const hours = Math.max(0, now - s.firstAt) / 3_600_000;
  const reachKm = Math.round(v * hours);
  const toBorderMin = s.occupied ? null : Math.max(0, Math.round(((b - reachKm) / v) * 60));
  return { reachKm, toBorderMin, borderKm: b };
}
