/**
 * Мова каналу як дані, а не як вкраплення в коді.
 *
 * Навіщо. Найбільша аудиторія цієї ніші, до якої ніхто не дотягується, — не
 * всередині країни, а поза нею: кореспонденти, аналітики, діаспора. Вони
 * цитують українські монітори щодня й читають їх через машинний переклад, який
 * плутає «крилаті» з «крилами», а «КАБ» — з таксі.
 *
 * Перекладати готовий пост не можна: він уже текст. Але наш пост будується не
 * з тексту, а зі СТРУКТУРИ (область → тип → кількість, курс, ETA), і саме тому
 * другу мову тут можна зробити чесно — не переклавши, а СКЛАВШИ заново з тих
 * самих чисел. Жодного машинного перекладу, жодного шансу, що англійський
 * канал скаже те, чого не казав український.
 *
 * Кожна мова — це об'єкт-словник. Додати третю означає дописати один об'єкт,
 * не торкаючись генератора.
 */

import type { ThreatType } from "./air";
import { normalizeThreatType } from "./air";

export type LangCode = "uk" | "en";

export interface Lexicon {
  code: LangCode;
  /** Назва типу з числом: «3 шахеди» / «3 Shahed drones». */
  typeName(type: ThreatType, n: number): string;
  /** Румб курсу за індексом 0..7 (0 = Пн, далі за годинниковою). */
  course(index: number): string;
  /**
   * Заголовок поста. `hourKyiv` — не косметика: частина варіантів прив'язана
   * до пори доби, і без години вони брехали б у кожному третьому пості.
   */
  headline(kind: HeadlineKind, seed: number, hourKyiv: number): string;
  tail(serious: boolean, seed: number): string;
  /** «— у бік: Полтава (~11 хв), уважно!» */
  towards(parts: string[]): string;
  /**
   * Ціль іде на центр ТІЄЇ САМОЇ області, у якій вона зараз.
   *
   * Окреме формулювання, бо довідник орієнтирів і групування користуються
   * одним переліком обласних центрів: група каже «ціль найближча до Полтави»,
   * а рядок напрямку — «летить на Полтаву», і виходить тавтологія «Полтавщина
   * — у бік: Полтавщина». Відомість при цьому НЕ зайва: людям у самому центрі
   * важливо знати, що йде на них. Тож не викидаємо її, а називаємо як є.
   */
  towardsOwnCentre(time: string): string;
  /** Тільки час, без назви міста — для `towardsOwnCentre`. */
  etaTime(minutes: number, range?: readonly [number, number]): string;
  /** «…і ще 4 області» */
  more(n: number): string;
  /** «Полтава (~11 хв)» */
  /**
   * Час до міста. `range` — вилка [найраніше, найпізніше], коли вона широка.
   *
   * Одне число тут іде в канал на всю країну, і саме тому воно найдорожче:
   * позиція відома з точністю, яку називає джерело, а «шахед» покриває і
   * 185 км/год, і 600. Вузька вилка лишається одним числом — зайва точність
   * у пості, який читають уночі, коштує уваги дорожче за свою користь.
   */
  eta(city: string, minutes: number, range?: readonly [number, number]): string;
  /** «🧭 хвиля йде на північ — на черзі: …» */
  wave(courseIndex: number, next: string[]): string;
  footer(targets: number, tail: string): string;
  /**
   * «Що змінилось» — КОЖНА частина окремим рядком.
   *
   * Раніше вони зліплювались в один рядок через «·», і читалось це навпаки до
   * змісту: «🆕 Вінниччина, Полтавщина · ✅ цілей не бачимо: Дніпропетровщина»
   * люди розуміли як «Вінниччина й Полтавщина чисті» — зелена позначка стояла
   * поруч із їхніми назвами. Плюс сам «🆕» Telegram малює бейджем NEW, який
   * нічого не каже українською.
   */
  delta: {
    escalated(types: string[]): string;
    appeared(oblasts: string[]): string;
    cleared(oblasts: string[]): string;
    grew(from: number, to: number): string;
    shrank(from: number, to: number): string;
  };
  /** Позначка «за це ручатись ніхто не може». */
  unverified: string;
  typeTag(type: ThreatType): string | undefined;
  alwaysTag: string;
}

export type HeadlineKind = "rocket" | "kab" | "swarm" | "few" | "calm";

function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length]!;
}

/**
 * Варіант заголовка, який має право зʼявитись лише у свою пору доби.
 *
 * Знадобилось після справжньої вади в каналі: серед трьох варіантів рою лежала
 * «Нічна зміна шахедів», вибір ішов за хешем вмісту поста — і приблизно кожен
 * третій денний рій оголошував ніч. Заголовок читають першим і часто єдиним;
 * хибне слово в ньому знецінює все під ним.
 *
 * Пора доби — не здогад, а відоме: київська година в нас є. Тому варіант не
 * викидаємо (він хороший, коли правдивий), а прив'язуємо до вікна.
 */
type HeadOption = string | { readonly text: string; readonly hours: readonly [number, number] };

/** Чи година в вікні `[from, to]` включно; вікно може переходити через північ. */
function inHourWindow(hour: number, [from, to]: readonly [number, number]): boolean {
  return from <= to ? hour >= from && hour <= to : hour >= from || hour <= to;
}

/**
 * Заголовок із пулу, звужений порою доби.
 *
 * Якщо жоден прив'язаний варіант не підходить, лишаються безчасові — саме тому
 * кожен пул мусить мати хоч один безчасовий варіант, і це перевірено тестом.
 * Порожній пул тут неможливий, але якби став можливим, краще мовчазний збій на
 * складанні, ніж заголовок, що бреше про час.
 */
function pickHead(arr: readonly HeadOption[], seed: number, hourKyiv: number): string {
  const fits = arr.filter((o) => typeof o === "string" || inHourWindow(hourKyiv, o.hours));
  const pool = fits.length ? fits : arr.filter((o): o is string => typeof o === "string");
  const chosen = pick(pool, seed);
  return typeof chosen === "string" ? chosen : chosen.text;
}

/* ─── Українська ────────────────────────────────────────────────────────── */

// Множина за українськими правилами (ті самі 3 форми: 1 / 2-4 / 5+).
export function pluralUk(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

const UK_TYPE: Record<ThreatType, [string, string, string]> = {
  shahed: ["шахед", "шахеди", "шахедів"],
  reactive: ["реактивний шахед", "реактивні шахеди", "реактивних шахедів"],
  cruise: ["крилата", "крилаті", "крилатих"],
  missile: ["ракета", "ракети", "ракет"],
  ballistic: ["балістична ціль", "балістичні цілі", "балістичних цілей"],
  kab: ["КАБ", "КАБи", "КАБів"],
  recon: ["розвідник", "розвідники", "розвідників"],
  aircraft: ["борт", "борти", "бортів"],
  unknown: ["ціль", "цілі", "цілей"],
};

const UK_COURSE = [
  "на північ",
  "на північний схід",
  "на схід",
  "на південний схід",
  "на південь",
  "на південний захід",
  "на захід",
  "на північний захід",
];

const UK_HEAD: Record<HeadlineKind, HeadOption[]> = {
  rocket: ["🚀 <b>Ракетна небезпека!</b>", "🚀 <b>Увага, ракети!</b>"],
  kab: ["💥 <b>КАБи в повітрі</b>", "💥 <b>Працюють КАБи</b>"],
  swarm: [
    "🛸 <b>Шахеди роєм</b>",
    "🛸 <b>Шахеди пачками</b>",
    // Пуски зазвичай починаються ввечері й тягнуться до світанку — саме це
    // вікно фраза й описує. О 14:00 вона просто неправда.
    { text: "🛸 <b>Нічна зміна шахедів</b>", hours: [22, 5] },
    // Дзеркальний випадок, і він вартий окремого слова: денний рій — рідкість,
    // і назвати його денним означає сказати читачеві щось справжнє.
    { text: "🛸 <b>Шахеди серед дня</b>", hours: [9, 17] },
  ],
  few: ["🛸 <b>Шахеди в небі</b>", "🛸 <b>Знову шахеди</b>", "🛸 <b>Дзижчать шахеди</b>"],
  calm: ["🛰 <b>Рух у небі</b>", "🛰 <b>Щось літає</b>"],
};

const UK_TAIL_SERIOUS = ["бережіть себе 🙏", "не ігноруйте тривогу", "укриття — не зайве 🛡"];
const UK_TAIL_LIGHT = [
  "бережіть себе 🙏",
  "ППО не спить — і ви пильнуйте 👀",
  "тримаємо на олівці ✍️",
  "павербанк на зарядку 🔋",
];

const UK_TAG: Partial<Record<ThreatType, string>> = {
  shahed: "шахеди",
  reactive: "шахеди",
  cruise: "ракети",
  missile: "ракети",
  ballistic: "балістика",
  kab: "КАБ",
};

/**
 * Час до міста словами — і межа, за якою вилка перестає бути корисною.
 *
 * Вилка чесна, але чесність тут не єдина вимога. Коли розкид позиції більший
 * за саму відстань до міста, нижній край вилки впирається в нуль, і виходить
 * «1–29 хв» — твердження формально правдиве й порожнє водночас. У пості, який
 * читають уночі, порожнє твердження коштує уваги так само, як хибне.
 *
 * Тому в такому стані замість числа йде те, що з нього насправді випливає:
 * ціль може бути вже поруч. Це коротше, це правда, і за цим зрозуміло, що
 * робити — на відміну від інтервалу завширшки з пів години.
 */
function etaPhraseUk(minutes: number, range?: readonly [number, number]): string {
  if (!range) return `~${minutes} хв`;
  const [near, far] = range;
  if (near <= 2 && far >= 10) return "може бути вже поруч";
  if (far - near >= 3) return `${near}–${far} хв`;
  return `~${minutes} хв`;
}

function etaPhraseEn(minutes: number, range?: readonly [number, number]): string {
  if (!range) return `~${minutes} min`;
  const [near, far] = range;
  if (near <= 2 && far >= 10) return "may already be close";
  if (far - near >= 3) return `${near}–${far} min`;
  return `~${minutes} min`;
}

export const UK: Lexicon = {
  code: "uk",
  typeName(type, n) {
    // Подвійний запобіжник: тип уже нормалізовано на межі, але саме цей пошук
    // валив увесь пост каналу, тож тут він не має права кидати виняток.
    const [one, few, many] = UK_TYPE[normalizeThreatType(type)];
    return pluralUk(n, one, few, many);
  },
  course: (i) => `курсом ${UK_COURSE[i % 8]}`,
  headline: (kind, seed, hourKyiv) => pickHead(UK_HEAD[kind], seed, hourKyiv),
  tail: (serious, seed) => pick(serious ? UK_TAIL_SERIOUS : UK_TAIL_LIGHT, seed),
  towards: (parts) => ` — у бік: ${parts.join(", ")}, уважно!`,
  towardsOwnCentre: (time) => ` — на обласний центр (${time}), уважно!`,
  etaTime: (minutes, range) => etaPhraseUk(minutes, range),
  more: (n) => `…і ще ${n} ${pluralUk(n, "область", "області", "областей")}`,
  eta: (city, minutes, range) => `${city} (${etaPhraseUk(minutes, range)})`,
  wave: (i, next) => `🧭 хвиля йде ${UK_COURSE[i % 8]} — на черзі: ${next.join(", ")}`,
  footer: (targets, tail) => `<i>всього в небі: ${targets} · за даними OSINT · ${tail}</i>`,
  delta: {
    escalated: (types) => `⚠️ <b>Додались:</b> ${types.join(", ")}`,
    // Словами, а не значком: Telegram малює «🆕» бейджем NEW, який нічого не
    // каже українською, — люди просто не розуміли, що він означає.
    appeared: (o) => `🔺 <b>Зʼявились цілі:</b> ${o.join(", ")}`,
    // «Відбій» тут не вживаємо НІ В ЯКІЙ формі: відбій дає офіційне
    // оголошення, а не те, що ми перестали бачити цілі над областю. І не
    // зеленою галочкою — вона читається як «чисто, все гаразд», тобто як
    // відбій, ще й для сусіднього рядка.
    cleared: (o) => `🔻 <b>Цілей більше не бачимо:</b> ${o.join(", ")}`,
    grew: (from, to) => `📈 Цілей більшає: ${from} → ${to}`,
    shrank: (from, to) => `📉 Цілей меншає: ${from} → ${to}`,
  },
  unverified: "❓ одне джерело",
  typeTag: (t) => UK_TAG[t],
  alwaysTag: "повітрянатривога",
};

/* ─── English ───────────────────────────────────────────────────────────── */

const EN_TYPE: Record<ThreatType, [string, string]> = {
  shahed: ["Shahed drone", "Shahed drones"],
  reactive: ["jet-powered Shahed", "jet-powered Shaheds"],
  cruise: ["cruise missile", "cruise missiles"],
  missile: ["missile", "missiles"],
  ballistic: ["ballistic target", "ballistic targets"],
  kab: ["glide bomb", "glide bombs"],
  recon: ["recon drone", "recon drones"],
  aircraft: ["aircraft", "aircraft"],
  unknown: ["target", "targets"],
};

const EN_COURSE = [
  "north",
  "north-east",
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
  "north-west",
];

const EN_HEAD: Record<HeadlineKind, HeadOption[]> = {
  rocket: ["🚀 <b>Missile threat</b>", "🚀 <b>Missiles inbound</b>"],
  kab: ["💥 <b>Glide bombs in the air</b>"],
  swarm: ["🛸 <b>Shahed swarm</b>", "🛸 <b>Mass drone attack</b>"],
  few: ["🛸 <b>Drones in the air</b>", "🛸 <b>Shaheds over Ukraine</b>"],
  calm: ["🛰 <b>Air activity</b>"],
};

// Англійський канал читають не ті, кому треба в укриття, а ті, хто про це
// пише. Тон стриманий, без «бережіть себе»: побажання незнайомій аудиторії за
// тисячу кілометрів звучало б фальшиво, а не тепло.
const EN_TAIL_SERIOUS = ["take shelter if you are in the area", "do not ignore local sirens"];
const EN_TAIL_LIGHT = ["tracking", "updates follow"];

const EN_TAG: Partial<Record<ThreatType, string>> = {
  shahed: "Shahed",
  reactive: "Shahed",
  cruise: "missiles",
  missile: "missiles",
  ballistic: "ballistic",
  kab: "glidebombs",
};

export const EN: Lexicon = {
  code: "en",
  typeName(type, n) {
    const [one, many] = EN_TYPE[normalizeThreatType(type)];
    return n === 1 ? one : many;
  },
  course: (i) => `heading ${EN_COURSE[i % 8]}`,
  headline: (kind, seed, hourKyiv) => pickHead(EN_HEAD[kind], seed, hourKyiv),
  tail: (serious, seed) => pick(serious ? EN_TAIL_SERIOUS : EN_TAIL_LIGHT, seed),
  towards: (parts) => ` — heading for ${parts.join(", ")}`,
  towardsOwnCentre: (time) => ` — heading for the regional centre (${time})`,
  etaTime: (minutes, range) => etaPhraseEn(minutes, range),
  more: (n) => `…and ${n} more ${n === 1 ? "region" : "regions"}`,
  eta: (city, minutes, range) => `${city} (${etaPhraseEn(minutes, range)})`,
  wave: (i, next) => `🧭 swarm moving ${EN_COURSE[i % 8]} — next: ${next.join(", ")}`,
  footer: (targets, tail) => `<i>${targets} in the air · OSINT data · ${tail}</i>`,
  delta: {
    escalated: (types) => `⚠️ <b>Added:</b> ${types.join(", ")}`,
    appeared: (o) => `🔺 <b>Targets appeared:</b> ${o.join(", ")}`,
    cleared: (o) => `🔻 <b>No longer tracked:</b> ${o.join(", ")}`,
    grew: (from, to) => `📈 Count rising: ${from} → ${to}`,
    shrank: (from, to) => `📉 Count falling: ${from} → ${to}`,
  },
  unverified: "❓ single source",
  typeTag: (t) => EN_TAG[t],
  alwaysTag: "Ukraine",
};

export const LEXICONS: Record<LangCode, Lexicon> = { uk: UK, en: EN };
