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
import { angularDiff, bearingDeg, speedRangeFor, SPEED_KMH } from "./threat-eta";
import { displayRadiusKm, EMPTY_QUALITY } from "./threat-quality";
import { swarmForecast } from "./swarm";
import { swarmForecastFor } from "./swarm-forecast";
import {
  type HeadlineKind,
  type LangCode,
  type Lexicon,
  LEXICONS,
  pluralUk,
  UK,
} from "./channel-lexicon";
import { verifyThreat } from "./advisory";
import { courseIsObserved } from "./threat-quality";
import { roleOfSource } from "./osint-sources";
import { kyivHour } from "./kyiv";

/** Індекс румба 0..7 за курсом. Слова дає словник — вони різні в різних мовах. */
function courseIndex(heading: number | undefined): number | null {
  if (typeof heading !== "number" || !Number.isFinite(heading)) return null;
  return Math.round((((heading % 360) + 360) % 360) / 45) % 8;
}

/**
 * СПІЛЬНИЙ курс групи — і лише коли він справді спільний.
 *
 * Раніше на всю групу брався курс ПЕРШОЇ цілі: «3 шахеди курсом на захід» —
 * навіть якщо другий ішов на південь, а третій на північ. На картинці ж кожна
 * стрілка своя, тож текст і зображення розповідали різне про той самий наліт.
 *
 * Тепер рахуємо круговий середній напрямок і його зібраність (довжину
 * результанта). Розкидані курси спільного напрямку НЕ мають — тоді краще не
 * називати жодного, ніж назвати чужий: повертаємо `null`, і рядок іде без
 * «курсом на…», а не з вигаданою одностайністю.
 */
function coherentCourse(headings: readonly number[]): number | null {
  const valid = headings.filter((h) => Number.isFinite(h));
  if (valid.length === 0) return null;
  if (valid.length === 1) return courseIndex(valid[0]);
  let sx = 0;
  let sy = 0;
  for (const h of valid) {
    const r = (h * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  // Довжина результанта 0..1: близько 1 — курси збіглися, близько 0 — розкидані.
  const resultant = Math.hypot(sx, sy) / valid.length;
  if (resultant < 0.75) return null; // приблизно ширше за ±40° — це вже не «спільний»
  const meanDeg = (Math.atan2(sy, sx) * 180) / Math.PI;
  return Math.round((((meanDeg % 360) + 360) % 360) / 45) % 8;
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
/**
 * Поріг «вже над містом», км.
 *
 * Знайдено в живому каналі: «📍 м. Київ: 2 шахеди курсом на північ — у бік:
 * м. Київ (4–14 хв)». Ціль уже була над містом, а рядок обіцяв, що вона туди
 * прилетить, — тобто подавав як новину те, що вже сталося, і плутав читача
 * рівно там, де він шукає ясності.
 *
 * Старий поріг у 3 км не рятував: великі міста ширші за нього в рази. Розрізняє
 * саме ВІДСТАНЬ, а не назва — довідник міст названо по областях («Полтавщина»
 * означає Полтаву), тож порівняння назв відкинуло б і законне попередження
 * «ціль в області йде на обласний центр».
 */
const ALREADY_OVER_CITY_KM = 12;

function loudCity(
  t: Threat,
  nearKm = 80,
  sectorDeg = 40,
): { name: string; etaMin: number; etaRangeMin: [number, number] } | null {
  if (typeof t.heading !== "number") return null;
  let best: { name: string; d: number } | null = null;
  for (const c of CITY_REFS) {
    const d = distanceKm(t, c);
    if (d > nearKm || d < ALREADY_OVER_CITY_KM) continue;
    const brg = bearingDeg(t, c);
    if (angularDiff(brg, t.heading) <= sectorDeg && (!best || d < best.d)) {
      best = { name: c.name, d };
    }
  }
  if (!best) return null;
  const q = t.quality ?? EMPTY_QUALITY;
  const speed = q.speedKmh ?? SPEED_KMH[t.type ?? "unknown"] ?? SPEED_KMH.unknown;
  // Вилка з тих самих двох причин, що й усюди: не знаємо точно, ДЕ ціль, і не
  // знаємо точно, ЩО це.
  const [slow, fast] = speedRangeFor(t.type, q.speedKmh);
  const u = displayRadiusKm(q);
  return {
    name: best.name,
    etaMin: Math.max(1, Math.round((best.d / speed) * 60)),
    etaRangeMin: [
      Math.max(1, Math.round((Math.max(0, best.d - u) / fast) * 60)),
      Math.max(1, Math.round(((best.d + u) / slow) * 60)),
    ],
  };
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
/**
 * Заголовок поста.
 *
 * Ескалація до «Ракетна небезпека!» — ЛИШЕ коли ракетний клас підтверджений
 * (офіційне джерело, два незалежні, або сам фід дає високу впевненість).
 *
 * Це закриває справжню ваду з живого каналу: одне непідтверджене повідомлення
 * про одну крилату піднімало заголовок усього зведення до максимальної тривоги,
 * тоді як тіло того ж поста чесно писало «❓ одне джерело». Пост сам собі
 * суперечив — а заголовок читають першим і часто єдиним.
 *
 * Ховати ракету теж не можна: якщо вона є, але не підтверджена, кажемо це
 * прямо окремим заголовком, а не або-кричимо-або-мовчимо.
 */
function headlineKind(
  types: ReadonlySet<ThreatType>,
  confirmed: ReadonlySet<ThreatType>,
  shaheds: number,
): HeadlineKind {
  if (isRocketish(confirmed)) return "rocket";
  if (confirmed.has("kab")) return "kab";
  if (isRocketish(types) || types.has("kab")) return "rocket_unconfirmed";
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
  confirmed: ReadonlySet<ThreatType> = new Set(),
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
    // Поява небезпечного типу — сама по собі ще не факт: якщо жодна така ціль
    // не підтверджена, так і пишемо. Інакше рядок «Додались: крилаті» звучав
    // твердженням там, де під ним у тілі стоїть «❓ одне джерело».
    bits.push(
      lex.delta.escalated(
        escalated.map((t) =>
          confirmed.has(t) ? lex.typeName(t, 2) : `${lex.typeName(t, 2)} ${lex.unverified}`,
        ),
      ),
    );
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
  /** Місто → найтерміновіший час до нього: найімовірніший і вилка. */
  loud: Map<string, { etaMin: number; etaRangeMin: [number, number] }>;
  /** Тип → усі спостережені курси цілей цього типу (для спільного напрямку). */
  courses: Map<ThreatType, number[]>;
  /**
   * Курси, які джерело позначило припущеними, — окремо від решти.
   *
   * Потрібно, щоб текст не стверджував більше за картинку: на зображенні
   * припущений курс уже малюється порожньою стрілкою, а рядок поряд казав
   * «курсом на південь» так само, як для заміряного.
   */
  guessed: Map<ThreatType, number[]>;
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
    /**
     * Стеля довжини. Задається, коли пост піде підписом до фото: Telegram
     * обмежує підпис 1024 символами, і перевищення коштує дорого — див.
     * `assemblePost`.
     */
    maxChars?: number;
    /**
     * Момент складання поста — лише для тих формулювань, що залежать від пори
     * доби (див. `pickHead` у лексиконі). Параметром, а не `Date.now()`
     * всередині, щоб тест міг перевірити полудень, не чекаючи полудня.
     */
    now?: number;
  } = {},
): ChannelPost | null {
  if (!threats.length) return null;
  const maxOblasts = opts.maxOblasts ?? 12;
  const hourKyiv = kyivHour(new Date(opts.now ?? Date.now()));
  const lex = LEXICONS[opts.lang ?? "uk"];

  const groups = new Map<string, Group>();
  // Типи, у яких є хоч ОДНА підтверджена ціль. Заголовок спирається на нього,
  // а не на сам факт присутності типу в картині.
  const confirmedTypes = new Set<ThreatType>();
  for (const t of threats) {
    const type: ThreatType = t.type ?? "unknown";
    const oblast = oblastOf(t.lat, t.lon);
    let g = groups.get(oblast);
    if (!g) {
      g = {
        oblast,
        byType: new Map(),
        loud: new Map(),
        courses: new Map(),
        guessed: new Map(),
        weak: 0,
        total: 0,
      };
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
    else confirmedTypes.add(type);
    // Збираємо ВСІ курси типу в групі — спільний напрямок вирахуємо потім, і
    // лише якщо він справді спільний (див. coherentCourse).
    if (typeof t.heading === "number" && Number.isFinite(t.heading)) {
      const list = g.courses.get(type);
      if (list) list.push(t.heading);
      else g.courses.set(type, [t.heading]);
      if (!courseIsObserved(t.quality ?? EMPTY_QUALITY)) {
        const guesses = g.guessed.get(type);
        if (guesses) guesses.push(t.heading);
        else g.guessed.set(type, [t.heading]);
      }
    }
    const loud = loudCity(t);
    if (loud) {
      const prev = g.loud.get(loud.name);
      // Порівнюємо за найранішим часом: у переліку має стояти найтерміновіше
      // з можливого, а не найімовірніше.
      if (prev === undefined || loud.etaRangeMin[0] < prev.etaRangeMin[0]) {
        g.loud.set(loud.name, { etaMin: loud.etaMin, etaRangeMin: loud.etaRangeMin });
      }
    }
  }

  // Найгарячіші області — де більше цілей — вище.
  const ordered = [...groups.values()].sort(
    (a, b) => total(b.byType) - total(a.byType) || a.oblast.localeCompare(b.oblast),
  );

  const snapshot = snapshotOf(ordered);
  const { line: deltaLine, material } = describeDelta(opts.previous, snapshot, lex, confirmedTypes);

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
      // Спільний курс — лише коли цілі справді йдуть разом; інакше без напрямку,
      // щоб текст не суперечив стрілкам на картинці.
      const all = g.courses.get(type) ?? [];
      const course = coherentCourse(all);
      /*
       * Позначаємо здогадку лише коли спостереженого курсу немає в ЖОДНОЇ цілі
       * типу — той самий поріг, що й для позначки непідтвердженості нижче.
       * Часткову слабкість читач однаково прочитає як повну, тож позначати
       * змішаний випадок означало б знецінити позначку там, де вимір є.
       */
      const allGuessed = all.length > 0 && (g.guessed.get(type)?.length ?? 0) === all.length;
      const dir =
        course === null ? "" : ` ${allGuessed ? lex.courseGuess(course) : lex.course(course)}`;
      return `${TYPE_EMOJI[type]} ${n} ${lex.typeName(type, n)}${dir}`;
    });
    let line = `📍 <b>${g.oblast}</b>: ${parts.join(", ")}`;
    // Без прийменника, щоб уникнути відмінка: назви в даних — у називному
    // («Харківщина», «Запоріжжя»), і «громко в Запоріжжя» різало б слух.
    if (g.loud.size) {
      /*
       * Ціль, що йде на центр СВОЄЇ ж області, називається окремо.
       *
       * `oblastOf` і довідник напрямків користуються одним переліком обласних
       * центрів, тож група й ціль часто збігаються — і рядок виходив
       * тавтологією: «📍 Полтавщина: … — у бік: Полтавщина». Викинути його не
       * можна (людям у центрі важливо, що йде на них), тому просто називаємо
       * те, що є: «на обласний центр».
       */
      const own = g.loud.get(g.oblast);
      const others = [...g.loud.entries()].filter(([n]) => n !== g.oblast);
      if (others.length) {
        line += lex.towards(others.map(([n, e]) => lex.eta(n, e.etaMin, e.etaRangeMin)));
      } else if (own) {
        line += lex.towardsOwnCentre(lex.etaTime(own.etaMin, own.etaRangeMin));
      }
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

  /*
   * Напрямок хвилі рою — «куди зміщується маса, які області на черзі».
   *
   * Перевага — СПОСТЕРЕЖЕНИЙ рух: курс І швидкість, виведені з трейлів цілей (з
   * відсівом стрибків-ототожнень), а не задекларований у полі курс. Це дає ще й
   * ETA у хвилинах: «на черзі Полтавщина (~12 хв)», а не просто «Полтавщина».
   *
   * Коли руху ще не видно (на початку нальоту трейли короткі) — відкат на курс
   * із поля джерела (swarm.ts, лише спостережені курси), щоб канал не змовк саме
   * тоді, коли прогноз найпотрібніший. Обидва мовчать, якщо напрямок невиражений.
   */
  const now = opts.now ?? Date.now();
  const observed = swarmForecastFor(threats, now, CITY_REFS, { horizonMin: 40, cityRadiusKm: 55 });
  let waveLine: string | null = null;
  if (
    observed &&
    observed.tracked >= 3 &&
    observed.swarm.coherence >= 0.6 &&
    observed.reach.length
  ) {
    waveLine =
      lex.wave(
        courseIndex(observed.swarm.bearingDeg) ?? 0,
        observed.reach.map((r) => lex.eta(r.name, r.etaMin)),
      ) + ` · за ${observed.tracked} спостереженими треками`;
  } else {
    /*
     * Прогноз називає, на скількох спостережених курсах він стоїть: «далі
     * Полтавщина» звучить однаково впевнено і за дванадцятьма курсами, і за
     * трьома з дванадцяти, — а це різні за вагою твердження. Припущені курси в
     * розрахунок не входять (див. swarmForecast), і коли їх відкинуто помітну
     * частину, читач має право це знати.
     */
    const wave = swarmForecast(threats, CITY_REFS);
    waveLine =
      wave && wave.next.length
        ? lex.wave(courseIndex(wave.heading) ?? 0, wave.next) +
          (wave.presumed > 0
            ? ` (за ${wave.count} спостереженими курсами з ${wave.count + wave.presumed})`
            : "")
        : null;
  }

  const tags = hashtags(
    ordered.map((g) => g.oblast),
    allTypes,
    lex,
  );
  const headline = lex.headline(headlineKind(allTypes, confirmedTypes, shaheds), seed, hourKyiv);
  const footer = lex.footer(targets, lex.tail(isRocketish(allTypes) || allTypes.has("kab"), seed));

  const text = assemblePost({
    headline,
    footer,
    bodyLines,
    ...(deltaLine ? { deltaLine } : {}),
    ...(waveLine ? { waveLine } : {}),
    ...(opts.forecast ? { forecast: opts.forecast } : {}),
    ...(tags ? { tags } : {}),
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
    more: (n) => lex.more(n),
  });

  return { text, signature, targets, snapshot, material, hashtags: tags };
}

/**
 * Збирає пост і ВТИСКАЄ його в стелю, не викидаючи головного.
 *
 * Це виправлення найгіршої вади, яку я знайшов у живому каналі.
 *
 * Пост іде підписом до картинки, а підпис у Telegram обмежений 1024 символами.
 * Старий код на перевищення просто відрізав усе, лишаючи шапку й підвал. У
 * каналі це виглядало так:
 *
 *     🚀 Ракетна небезпека!
 *     всього в небі: 14 · за даними OSINT
 *
 * Чотирнадцять цілей у небі — і жодної названої області. Вада зворотна за
 * знаком: що більший наліт, то менше пост повідомляє, бо саме у великий наліт
 * текст і переростає стелю. Система мовчала рівно тоді, коли була потрібна.
 *
 * Тепер відрізається за пріоритетом, і перелік областей — останнє, що піде.
 * Порядок продуманий: спершу хештеги (пошук важливий, але не зараз), далі
 * прогноз (здогадка), далі рядок змін (контекст), далі найспокійніші області
 * — і лише вони, зі згорткою «…і ще N». Шапка й підвал лишаються завжди.
 */
export function assemblePost(input: {
  headline: string;
  footer: string;
  bodyLines: readonly string[];
  deltaLine?: string;
  waveLine?: string;
  forecast?: string;
  tags?: string;
  maxChars?: number;
  more: (n: number) => string;
}): string {
  const build = (opts: {
    body: readonly string[];
    hidden: number;
    delta: boolean;
    wave: boolean;
    forecast: boolean;
    tags: boolean;
  }): string =>
    [
      input.headline,
      ...(opts.delta && input.deltaLine ? ["", input.deltaLine] : []),
      "",
      ...opts.body,
      ...(opts.hidden > 0 ? [input.more(opts.hidden)] : []),
      ...(opts.wave && input.waveLine ? ["", input.waveLine] : []),
      ...(opts.forecast && input.forecast ? ["", input.forecast] : []),
      "",
      input.footer,
      ...(opts.tags && input.tags ? [input.tags] : []),
    ].join("\n");

  const full = {
    body: input.bodyLines,
    hidden: 0,
    delta: true,
    wave: true,
    forecast: true,
    tags: true,
  };
  const limit = input.maxChars;
  let text = build(full);
  if (limit === undefined || text.length <= limit) return text;

  // Черга поступок, від найменш цінної до найболючішої.
  const steps: (() => void)[] = [
    () => (full.tags = false),
    () => (full.forecast = false),
    () => (full.wave = false),
    () => (full.delta = false),
  ];
  for (const step of steps) {
    step();
    text = build(full);
    if (text.length <= limit) return text;
  }

  // Лишились самі області — ріжемо найспокійніші з хвоста (вони вже
  // відсортовані за кількістю цілей), але хоча б одну лишаємо завжди:
  // пост без жодної області не варто слати взагалі.
  for (let keep = input.bodyLines.length - 1; keep >= 1; keep--) {
    full.body = input.bodyLines.slice(0, keep);
    full.hidden = input.bodyLines.length - keep;
    text = build(full);
    if (text.length <= limit) return text;
  }
  return text;
}

function total(m: Map<ThreatType, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
