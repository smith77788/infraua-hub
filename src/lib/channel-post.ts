/**
 * Автопост у Telegram-канал живою мовою народних моніторів повітряної
 * обстановки: не сухе «зафіксовано рух БпЛА», а «Сумщина: 3 шахеди курсом на
 * північ — у бік Конотопа, уважно».
 *
 * Навіщо окремим модулем і чистою функцією. Канал веде не людина, а система:
 * вона щоразу бере ті самі дані, що на карті (getThreats), і сама складає
 * пост. Щоб цьому можна було вірити й це можна було перевірити тестами,
 * генерація тексту не торкається ні мережі, ні годинника — лише вхідні цілі.
 *
 * Мова — українська, жива й тепла, як у народних моніторів (RADAR.RIVNE,
 * monitoring захід): «шахеди в небі», «у бік міста — уважно», «відбій».
 * Уся лексика зібрана тут, в одному місці, а не розсипана по коду.
 *
 * Дедуп. Ситуація в небі змінюється повільно; без дедупу канал спамив би той
 * самий пост щохвилини. Тому разом із текстом повертається `signature` —
 * стабільний відбиток згрупованої картини. Той, хто постить, порівнює його з
 * останнім надісланим і мовчить, якщо нічого не змінилось.
 */

import type { Threat, ThreatType } from "./air";
import { OBLASTS } from "./alerts";
import { distanceKm } from "./infra-types";
import { angularDiff, bearingDeg, SPEED_KMH } from "./threat-eta";
import { swarmForecast } from "./swarm";

// Множина за українськими правилами (ті самі 3 форми: 1 / 2-4 / 5+).
function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

const TYPE_PLURAL: Record<ThreatType, [string, string, string]> = {
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

function typePlural(type: ThreatType, n: number): string {
  const [one, few, many] = TYPE_PLURAL[type];
  return plural(n, one, few, many);
}

// Румб курсу українською: «курсом на північний захід».
const COURSE_8 = [
  "на північ",
  "на північний схід",
  "на схід",
  "на південний схід",
  "на південь",
  "на південний захід",
  "на захід",
  "на північний захід",
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

// Орієнтири для «у бік міста — уважно»: обласні центри (публічні координати).
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
 * Чи йде ціль на місто поблизу — тоді «у бік міста, ~N хв — уважно».
 * Місто в межах `nearKm` і курс у секторі ±`sectorDeg` на нього. ETA — за
 * типовою швидкістю типу цілі (SPEED_KMH): орієнтир, скільки лишилось.
 */
function loudCity(t: Threat, nearKm = 80, sectorDeg = 40): { name: string; etaMin: number } | null {
  if (typeof t.heading !== "number") return null;
  let best: { name: string; d: number } | null = null;
  for (const c of CITY_REFS) {
    const d = distanceKm(t, c);
    if (d > nearKm || d < 3) continue;
    const brg = bearingDeg(t, c);
    if (angularDiff(brg, t.heading) <= sectorDeg && (!best || d < best.d)) {
      best = { name: c.name, d };
    }
  }
  if (!best) return null;
  const speed = SPEED_KMH[t.type ?? "unknown"] ?? SPEED_KMH.unknown;
  return { name: best.name, etaMin: Math.max(1, Math.round((best.d / speed) * 60)) };
}

// Значок типу цілі — щоб пост читався оком, а не суцільним рядком.
const TYPE_EMOJI: Record<ThreatType, string> = {
  shahed: "🛸",
  reactive: "🛸",
  cruise: "🚀",
  missile: "🚀",
  ballistic: "🎯",
  kab: "💥",
  recon: "👁",
  aircraft: "✈️",
  unknown: "❔",
};

/**
 * Живість без випадковості. Канал має звучати як людина, а не шаблон, але
 * лишатися чистою функцією (щоб тестуватись і давати стабільний підпис). Тому
 * варіанти фраз обираються ДЕТЕРМІНОВАНО — за «насінням» від підпису картини:
 * різні ситуації звучать по-різному, а та сама — однаково.
 */
function seedFrom(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length]!;
}

// Заголовки за найгострішим типом. Для ракет — серйозно, без жартів; для
// «мопедів» дозволена жива подача. Формулювання чесні: це OSINT, не гарантія.
const HEAD_ROCKET = ["🚀 <b>Ракетна небезпека!</b>", "🚀 <b>Увага, ракети!</b>"];
const HEAD_KAB = ["💥 <b>КАБи в повітрі</b>", "💥 <b>Працюють КАБи</b>"];
const HEAD_SWARM = [
  "🛸 <b>Шахеди роєм</b>",
  "🛸 <b>Шахеди пачками</b>",
  "🛸 <b>Нічна зміна шахедів</b>",
];
const HEAD_FEW = ["🛸 <b>Шахеди в небі</b>", "🛸 <b>Знову шахеди</b>", "🛸 <b>Дзижчать шахеди</b>"];
const HEAD_CALM = ["🛰 <b>Рух у небі</b>", "🛰 <b>Щось літає</b>"];

// Кінцівка. Для небезпечних типів — стримано; для решти — теплий, живий тон
// (не глузування з небезпеки, а «свій» голос монітора, що звертається до людей).
const TAIL_SERIOUS = ["бережіть себе 🙏", "не ігноруйте тривогу", "укриття — не зайве 🛡"];
const TAIL_LIGHT = [
  "бережіть себе 🙏",
  "ППО не спить — і ви пильнуйте 👀",
  "тримаємо на олівці ✍️",
  "павербанк на зарядку 🔋",
];

function isRocketish(types: ReadonlySet<ThreatType>): boolean {
  return types.has("missile") || types.has("ballistic") || types.has("cruise");
}
function headline(types: ReadonlySet<ThreatType>, shaheds: number, seed: number): string {
  if (isRocketish(types)) return pick(HEAD_ROCKET, seed);
  if (types.has("kab")) return pick(HEAD_KAB, seed);
  if (types.has("shahed") || types.has("reactive")) {
    return pick(shaheds >= 8 ? HEAD_SWARM : HEAD_FEW, seed);
  }
  return pick(HEAD_CALM, seed);
}
function tail(types: ReadonlySet<ThreatType>, seed: number): string {
  const serious = isRocketish(types) || types.has("kab");
  return pick(serious ? TAIL_SERIOUS : TAIL_LIGHT, seed);
}

/**
 * Хештеги під постом.
 *
 * Не прикраса. Telegram шукає по хештегах усередині каналу й індексує їх у
 * глобальному пошуку — тобто людина, яка вперше в житті шукає «#Сумщина», може
 * знайти цей канал, ніколи про нього не чувши. Це єдиний безкоштовний спосіб
 * потрапити в чужий пошук, і він коштує нам один рядок.
 *
 * Тег складається лише з літер: Telegram обриває хештег на першому ж не-літері,
 * тож «#м. Київ» став би «#м» — марним тегом, який ще й ламає пошук.
 */
const TYPE_TAG: Partial<Record<ThreatType, string>> = {
  shahed: "шахеди",
  reactive: "шахеди",
  cruise: "ракети",
  missile: "ракети",
  ballistic: "балістика",
  kab: "КАБ",
};

export function hashtags(oblasts: readonly string[], types: ReadonlySet<ThreatType>): string {
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const clean = raw.replace(/[^\p{L}\p{N}]/gu, "");
    if (clean.length < 3 || seen.has(clean)) return;
    seen.add(clean);
    tags.push(`#${clean}`);
  };
  // Області йдуть першими: саме їх шукають («що в мене в області»).
  for (const o of oblasts.slice(0, 6)) push(o);
  for (const t of types) {
    const tag = TYPE_TAG[t];
    if (tag) push(tag);
  }
  push("повітрянатривога");
  return tags.join(" ");
}

/**
 * Кнопки під постом каналу — місток «читач каналу → власний радар».
 *
 * Канал відповідає на «що в небі над країною»; людині потрібне «чи летить це
 * на мене». Кнопка під кожним постом веде саме туди, і — головне — вона
 * їде разом із пересланим постом: хто б куди не переслав зведення, кнопка
 * лишається робочою. Це і є та петля, заради якої все інше.
 */
export function channelKeyboard(
  botLink: string | null,
  mapUrl: string | null,
): { inline_keyboard: { text: string; url: string }[][] } | undefined {
  const row: { text: string; url: string }[] = [];
  if (botLink) row.push({ text: "🎯 Чи летить на мене?", url: botLink });
  if (mapUrl) row.push({ text: "🗺 Карта", url: mapUrl });
  return row.length ? { inline_keyboard: [row] } : undefined;
}

/** Структурований зріз обстановки — область → тип → кількість ОБ'ЄКТІВ. */
export interface AirSnapshot {
  oblasts: Record<string, Partial<Record<ThreatType, number>>>;
  targets: number;
}

function snapshotOf(groups: Iterable<Group>): AirSnapshot {
  const oblasts: Record<string, Partial<Record<ThreatType, number>>> = {};
  let targets = 0;
  for (const g of groups) {
    const m: Partial<Record<ThreatType, number>> = {};
    for (const [type, n] of g.byType) {
      m[type] = n;
      targets += n;
    }
    oblasts[g.oblast] = m;
  }
  return { oblasts, targets };
}

/**
 * «Що змінилось із минулого разу» — щоб пост читався як живе оновлення, а не
 * повторний дамп тієї самої картини. Повертає ще й `material`: чи зміна варта
 * окремого поста (нова/зникла область, ескалація типу, помітна зміна кількості).
 * Без попереднього зрізу все — матеріальне (перша зведення).
 */
function describeDelta(
  prev: AirSnapshot | undefined,
  cur: AirSnapshot,
): { line: string | null; material: boolean } {
  if (!prev) return { line: null, material: true };

  const prevOblasts = new Set(Object.keys(prev.oblasts));
  const curOblasts = new Set(Object.keys(cur.oblasts));
  const appeared = [...curOblasts].filter((o) => !prevOblasts.has(o));
  const cleared = [...prevOblasts].filter((o) => !curOblasts.has(o));

  const dangerBefore = new Set<ThreatType>();
  for (const m of Object.values(prev.oblasts)) {
    for (const t of Object.keys(m) as ThreatType[]) dangerBefore.add(t);
  }
  const escalated: ThreatType[] = [];
  for (const m of Object.values(cur.oblasts)) {
    for (const t of Object.keys(m) as ThreatType[]) {
      const dangerous = t === "missile" || t === "cruise" || t === "ballistic" || t === "kab";
      if (dangerous && !dangerBefore.has(t) && !escalated.includes(t)) escalated.push(t);
    }
  }

  const totalDelta = cur.targets - prev.targets;
  const material =
    appeared.length > 0 || cleared.length > 0 || escalated.length > 0 || Math.abs(totalDelta) >= 2;

  const bits: string[] = [];
  if (escalated.length)
    bits.push(`⚠️ додались ${escalated.map((t) => typePlural(t, 2)).join(", ")}`);
  if (appeared.length) bits.push(`🆕 ${appeared.join(", ")}`);
  if (cleared.length) bits.push(`✅ відбій: ${cleared.join(", ")}`);
  if (!bits.length && totalDelta !== 0) {
    bits.push(
      totalDelta > 0
        ? `📈 цілей більшає (${prev.targets}→${cur.targets})`
        : `📉 цілей меншає (${prev.targets}→${cur.targets})`,
    );
  }
  return { line: bits.length ? bits.join(" · ") : null, material };
}

export interface ChannelPost {
  text: string;
  /** Відбиток картини для дедупу: області+типи+кількість (без курсу). */
  signature: string;
  /** Скільки цілей (ОБ'ЄКТІВ) у небі — не згадок. */
  targets: number;
  /** Зріз обстановки — щоб наступний пост показав зміну. */
  snapshot: AirSnapshot;
  /** Чи змінилось суттєво від previous — сигнал постити чи промовчати. */
  material: boolean;
  /** Рядок хештегів, уже вкладений у текст (порожній — тегувати не було чим). */
  hashtags: string;
}

interface Group {
  oblast: string;
  byType: Map<ThreatType, number>;
  /** Місто на курсі → мінімальна ETA (хв). */
  loud: Map<string, number>;
  courses: Map<ThreatType, string>;
}

/**
 * Складає пост каналу з поточних цілей. `null` — постити нічого (небо чисте):
 * канал у стилі «Ванька» не пише «целей нет» щохвилини.
 */
export function renderChannelPost(
  threats: readonly Threat[],
  opts: {
    previous?: AirSnapshot | undefined;
    maxOblasts?: number;
    /** Рядок прогнозу («за курсом далі…») — готує channel-wave. */
    forecast?: string | null;
  } = {},
): ChannelPost | null {
  if (!threats.length) return null;
  const maxOblasts = opts.maxOblasts ?? 12;

  const groups = new Map<string, Group>();
  for (const t of threats) {
    const type: ThreatType = t.type ?? "unknown";
    const oblast = oblastOf(t.lat, t.lon);
    let g = groups.get(oblast);
    if (!g) {
      g = { oblast, byType: new Map(), loud: new Map(), courses: new Map() };
      groups.set(oblast, g);
    }
    // Рахуємо ОБ'ЄКТИ (1 ціль = 1), а не поле count. count — це кількість
    // згадок у OSINT-каналах (впевненість джерела), а НЕ кількість дронів;
    // додавати його означало б писати «17 мопедів» там, де ціль одна. Карта
    // теж рахує об'єкти — так канал і карта показують одне число.
    g.byType.set(type, (g.byType.get(type) ?? 0) + 1);
    const course = coursePhrase(t.heading);
    if (course && !g.courses.has(type)) g.courses.set(type, course);
    const loud = loudCity(t);
    if (loud) {
      const prev = g.loud.get(loud.name);
      if (prev === undefined || loud.etaMin < prev) g.loud.set(loud.name, loud.etaMin);
    }
  }

  // Найгарячіші області — де більше цілей — вище.
  const ordered = [...groups.values()].sort(
    (a, b) => total(b.byType) - total(a.byType) || a.oblast.localeCompare(b.oblast),
  );

  const snapshot = snapshotOf(ordered);
  const { line: deltaLine, material } = describeDelta(opts.previous, snapshot);

  const allTypes = new Set<ThreatType>();
  const sigParts: string[] = [];
  const bodyLines: string[] = [];
  let shaheds = 0;
  // Підпис (дедуп) читає ВСІ області, а тіло — лише перші maxOblasts: у масований
  // наліт десятки областей зробили б пост завеликим (ліміт Telegram 4096) і
  // нечитабельним. Решта згортається в один рядок «…и ещё N областей».
  ordered.forEach((g, idx) => {
    const entries = [...g.byType.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, n] of entries) {
      allTypes.add(type);
      if (type === "shahed" || type === "reactive") shaheds += n;
      sigParts.push(`${g.oblast}:${type}:${n}`);
    }
    if (idx >= maxOblasts) return;
    const parts = entries.map(([type, n]) => {
      const course = g.courses.get(type);
      // Значок веде тип, далі — кількість словом у «ванёк»-регістрі й курс.
      return `${TYPE_EMOJI[type]} ${n} ${typePlural(type, n)}${course ? ` курсом ${course}` : ""}`;
    });
    let line = `📍 <b>${g.oblast}</b>: ${parts.join(", ")}`;
    // Без прийменника, щоб уникнути відмінка: назви в даних — у називному
    // («Харківщина», «Запоріжжя»), і «громко в Запоріжжя» різало б слух.
    if (g.loud.size) {
      const near = [...g.loud.entries()].map(([n, e]) => `${n} (~${e} хв)`);
      line += ` — у бік: ${near.join(", ")}, уважно!`;
    }
    bodyLines.push(line);
  });
  const hidden = ordered.length - Math.min(ordered.length, maxOblasts);
  if (hidden > 0) {
    bodyLines.push(`…і ще ${hidden} ${plural(hidden, "область", "області", "областей")}`);
  }

  const targets = threats.length;
  const signature = sigParts.sort().join("|");
  const seed = seedFrom(signature);

  // Напрямок хвилі рою — «куди зміщується маса, які області на черзі».
  // Даємо лише коли напрямок виражений (див. swarmForecast), інакше мовчимо.
  const wave = swarmForecast(threats, CITY_REFS);
  const waveLine =
    wave && wave.next.length
      ? `🧭 хвиля йде ${wave.course} — на черзі: ${wave.next.join(", ")}`
      : null;

  const tags = hashtags(
    ordered.map((g) => g.oblast),
    allTypes,
  );
  const lines = [
    headline(allTypes, shaheds, seed),
    ...(deltaLine ? ["", deltaLine] : []),
    "",
    ...bodyLines,
    ...(waveLine ? ["", waveLine] : []),
    ...(opts.forecast ? ["", opts.forecast] : []),
    "",
    `<i>всього в небі: ${targets} · за даними OSINT · ${tail(allTypes, seed)}</i>`,
    ...(tags ? [tags] : []),
  ];

  return { text: lines.join("\n"), signature, targets, snapshot, material, hashtags: tags };
}

function total(m: Map<ThreatType, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
