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
 * Мова — жива й тепла, як у народних моніторів (RADAR.RIVNE, monitoring
 * захід): «шахеди в небі», «у бік міста — уважно». Сама лексика винесена в
 * `channel-lexicon.ts`: пост будується не з тексту, а зі структури, тож той
 * самий генератор складає українську й англійську версію з тих самих чисел —
 * не перекладаючи, а складаючи заново.
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
import { type LangCode, type Lexicon, LEXICONS, pluralUk, UK } from "./channel-lexicon";
import { verifyThreat } from "./advisory";
import { roleOfSource } from "./osint-sources";

/** Індекс румба 0..7 за курсом. Слова дає словник — вони різні в різних мовах. */
function courseIndex(heading: number | undefined): number | null {
  if (typeof heading !== "number" || !Number.isFinite(heading)) return null;
  return Math.round((((heading % 360) + 360) % 360) / 45) % 8;
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

function isRocketish(types: ReadonlySet<ThreatType>): boolean {
  return types.has("missile") || types.has("ballistic") || types.has("cruise");
}
function headlineKind(
  types: ReadonlySet<ThreatType>,
  shaheds: number,
): "rocket" | "kab" | "swarm" | "few" | "calm" {
  if (isRocketish(types)) return "rocket";
  if (types.has("kab")) return "kab";
  if (types.has("shahed") || types.has("reactive")) return shaheds >= 8 ? "swarm" : "few";
  return "calm";
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
export function hashtags(
  oblasts: readonly string[],
  types: ReadonlySet<ThreatType>,
  lex: Lexicon = UK,
): string {
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
    const tag = lex.typeTag(t);
    if (tag) push(tag);
  }
  push(lex.alwaysTag);
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
  lex: Lexicon,
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
  if (escalated.length) {
    bits.push(lex.delta.escalated(escalated.map((t) => lex.typeName(t, 2))));
  }
  if (appeared.length) bits.push(lex.delta.appeared(appeared));
  // «Відбій» тут не вживаємо НІ В ЯКІЙ формі: відбій дає офіційне оголошення,
  // а не те, що ми перестали бачити цілі над областю.
  if (cleared.length) bits.push(lex.delta.cleared(cleared));
  if (!bits.length && totalDelta !== 0) {
    bits.push(
      totalDelta > 0
        ? lex.delta.grew(prev.targets, cur.targets)
        : lex.delta.shrank(prev.targets, cur.targets),
    );
  }
  // Кожна зміна — окремим рядком. Склеєні через «·», вони читались навпаки:
  // зелена позначка «цілей не бачимо» опинялась поруч із назвами областей, де
  // цілі щойно ЗʼЯВИЛИСЬ, і люди розуміли рядок як «там чисто».
  return { line: bits.length ? bits.join("\n") : null, material };
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
  /** Тип → індекс румба 0..7 (слова дає словник). */
  courses: Map<ThreatType, number>;
  /** Скільки цілей області спираються лише на одне непідтверджене джерело. */
  weak: number;
  total: number;
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
    /** Мова поста. Усталено українська; англійська — для дзеркального каналу. */
    lang?: LangCode;
  } = {},
): ChannelPost | null {
  if (!threats.length) return null;
  const maxOblasts = opts.maxOblasts ?? 12;
  const lex = LEXICONS[opts.lang ?? "uk"];

  const groups = new Map<string, Group>();
  for (const t of threats) {
    const type: ThreatType = t.type ?? "unknown";
    const oblast = oblastOf(t.lat, t.lon);
    let g = groups.get(oblast);
    if (!g) {
      g = { oblast, byType: new Map(), loud: new Map(), courses: new Map(), weak: 0, total: 0 };
      groups.set(oblast, g);
    }
    // Рахуємо ОБ'ЄКТИ (1 ціль = 1), а не поле count. count — це кількість
    // згадок у OSINT-каналах (впевненість джерела), а НЕ кількість дронів;
    // додавати його означало б писати «17 мопедів» там, де ціль одна. Карта
    // теж рахує об'єкти — так канал і карта показують одне число.
    g.byType.set(type, (g.byType.get(type) ?? 0) + 1);
    // Наскільки цій позначці можна вірити. Модулі верифікації в проєкті вже
    // були, але жоден пост їх не показував — тож читач не міг відрізнити
    // «три незалежні канали» від «одна людина щось написала». Саме на цій
    // різниці й живуть паніка та фейки в ніші.
    const level = verifyThreat(t, roleOfSource).level;
    g.total += 1;
    if (level === "unverified" || level === "single") g.weak += 1;
    const course = courseIndex(t.heading);
    if (course !== null && !g.courses.has(type)) g.courses.set(type, course);
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
  const { line: deltaLine, material } = describeDelta(opts.previous, snapshot, lex);

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
      const dir = course === undefined ? "" : ` ${lex.course(course)}`;
      return `${TYPE_EMOJI[type]} ${n} ${lex.typeName(type, n)}${dir}`;
    });
    let line = `📍 <b>${g.oblast}</b>: ${parts.join(", ")}`;
    // Без прийменника, щоб уникнути відмінка: назви в даних — у називному
    // («Харківщина», «Запоріжжя»), і «громко в Запоріжжя» різало б слух.
    if (g.loud.size) {
      line += lex.towards([...g.loud.entries()].map(([n, e]) => lex.eta(n, e)));
    }
    // Позначка стоїть ЛИШЕ коли підтвердження немає в жодної цілі області:
    // часткова слабкість тут не повідомляється, бо «частково непідтверджено»
    // читач однаково прочитає як «непідтверджено» і знеціниться вся позначка.
    if (g.total > 0 && g.weak === g.total) line += ` ${lex.unverified}`;
    bodyLines.push(line);
  });
  const hidden = ordered.length - Math.min(ordered.length, maxOblasts);
  if (hidden > 0) {
    bodyLines.push(lex.more(hidden));
  }

  const targets = threats.length;
  const signature = sigParts.sort().join("|");
  const seed = seedFrom(signature);

  // Напрямок хвилі рою — «куди зміщується маса, які області на черзі».
  // Даємо лише коли напрямок виражений (див. swarmForecast), інакше мовчимо.
  const wave = swarmForecast(threats, CITY_REFS);
  const waveLine =
    wave && wave.next.length ? lex.wave(courseIndex(wave.heading) ?? 0, wave.next) : null;

  const tags = hashtags(
    ordered.map((g) => g.oblast),
    allTypes,
    lex,
  );
  const lines = [
    lex.headline(headlineKind(allTypes, shaheds), seed),
    ...(deltaLine ? ["", deltaLine] : []),
    "",
    ...bodyLines,
    ...(waveLine ? ["", waveLine] : []),
    ...(opts.forecast ? ["", opts.forecast] : []),
    "",
    lex.footer(targets, lex.tail(isRocketish(allTypes) || allTypes.has("kab"), seed)),
    ...(tags ? [tags] : []),
  ];

  return { text: lines.join("\n"), signature, targets, snapshot, material, hashtags: tags };
}

function total(m: Map<ThreatType, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
