/**
 * Хвиля як подія, а не як низка однакових постів.
 *
 * Канали цієї ніші влаштовані однаково: кожні кілька хвилин новий пост із тим
 * самим переліком областей. За ніч це 60–80 повідомлень, у яких нічого не
 * знайти вранці, і рівно тому канал вимикають або читають через «без звуку».
 *
 * Тут інша модель. Наліт — це **одна хвиля** з початком, розвитком і відбоєм:
 *  • поки вона триває — редагується один живий пост, а не плодяться нові;
 *  • коли вона скінчилась — виходить «Відбій» зі зведенням: скільки тривала,
 *    який був пік, які області зачепило;
 *  • раз на добу — підсумок дня.
 *
 * І ще одне, чого немає ні в кого: **куди хвиля йде далі**. Курс і типова
 * швидкість у даних уже є, тож область, у яку цілі ввійдуть за 10–30 хвилин,
 * можна назвати до того, як вони туди дійдуть. Це прогноз, а не факт, і в
 * тексті він так і названий — правило проєкту: оцінене не видають за заміряне.
 *
 * Модуль чистий: без мережі, без годинника (час приходить аргументом).
 */

import type { ThreatType, Threat } from "./air";
import type { AirSnapshot } from "./channel-post";
import { oblastOf } from "./channel-post";
import { formatDuration } from "./kyiv";
import { SPEED_KMH } from "./threat-eta";

/* ─── 1. Прогноз руху хвилі ─────────────────────────────────────────────── */

const EARTH_KM = 6371;

/** Точка за `km` від заданої в напрямку `headingDeg` (0 = Пн). */
export function movePoint(
  lat: number,
  lon: number,
  headingDeg: number,
  km: number,
): { lat: number; lon: number } {
  const δ = km / EARTH_KM;
  const θ = (headingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lon: (((λ2 * 180) / Math.PI + 540) % 360) - 180 };
}

export interface ForecastEntry {
  oblast: string;
  /** За скільки хвилин перша ціль увійде в цю область (оцінка). */
  minutes: number;
  /** Скільки цілей туди прямує. */
  count: number;
  types: ThreatType[];
}

/**
 * Куди хвиля прийде найближчим часом.
 *
 * Метод названо прямо, бо від нього залежить, наскільки числу можна вірити:
 * ціль ведеться по прямій за своїм курсом із типовою швидкістю свого типу, і
 * фіксується ПЕРША область, відмінна від тієї, над якою вона зараз. Це не
 * траєкторія — цілі маневрують, а курс у даних оновлюється рідко. Тому горизонт
 * короткий (усталено 30 хв): далі за нього пряма перестає бути схожою на
 * правду.
 *
 * Області, де цілі вже зараз, у прогноз не потрапляють: про них сказано в
 * самому пості, і повторювати їх як «очікуємо» означало б лякати вже відомим.
 */
export function forecastWave(
  threats: readonly Threat[],
  opts: { horizonMin?: number; stepMin?: number } = {},
): ForecastEntry[] {
  const horizon = opts.horizonMin ?? 30;
  const step = opts.stepMin ?? 3;

  const occupied = new Set<string>();
  for (const t of threats) occupied.add(oblastOf(t.lat, t.lon));

  const acc = new Map<string, { minutes: number; count: number; types: Set<ThreatType> }>();
  for (const t of threats) {
    if (typeof t.heading !== "number" || !Number.isFinite(t.heading)) continue;
    const type: ThreatType = t.type ?? "unknown";
    const speed = SPEED_KMH[type] ?? SPEED_KMH.unknown;
    const here = oblastOf(t.lat, t.lon);
    for (let m = step; m <= horizon; m += step) {
      const p = movePoint(t.lat, t.lon, t.heading, (speed * m) / 60);
      const there = oblastOf(p.lat, p.lon);
      if (there === here) continue;
      if (occupied.has(there)) break; // туди цілі вже долетіли — не прогноз
      const prev = acc.get(there);
      if (!prev) acc.set(there, { minutes: m, count: 1, types: new Set([type]) });
      else {
        prev.count += 1;
        prev.types.add(type);
        if (m < prev.minutes) prev.minutes = m;
      }
      break; // перша нова область — і досить
    }
  }

  return [...acc.entries()]
    .map(([oblast, v]) => ({
      oblast,
      minutes: v.minutes,
      count: v.count,
      types: [...v.types],
    }))
    .sort((a, b) => a.minutes - b.minutes || b.count - a.count);
}

/** Рядок прогнозу в пості. `null` — прогнозувати нічого. */
export function renderForecast(entries: readonly ForecastEntry[], max = 3): string | null {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, max);
  const parts = shown.map((e) => `${e.oblast} (~${e.minutes} хв)`);
  const rest = entries.length - shown.length;
  return `🔮 <b>За курсом далі:</b> ${parts.join(", ")}${rest > 0 ? ` і ще ${rest}` : ""}`;
}

/* ─── 2. Хвиля як сесія ─────────────────────────────────────────────────── */

export interface WaveState {
  startedAt: number;
  /** Коли востаннє в небі щось було. */
  lastActiveAt: number;
  peakTargets: number;
  /** Область → найбільше, що бачили над нею одночасно. */
  oblasts: Record<string, number>;
  /** Тип → найбільше одночасно. */
  types: Partial<Record<ThreatType, number>>;
  /** Повідомлення живого поста, яке редагується; `null` — ще не постили. */
  messageId: number | null;
  /** Скільки разів редагували живий пост. */
  edits: number;
  /**
   * Чи бачили ми за цю хвилю ОФІЦІЙНУ тривогу в якійсь із її областей.
   *
   * Без цього прапорця відбій виходив би й там, де тривоги не оголошували
   * взагалі (поодинокий розвідник, рух без сирени). «Відбій» без тривоги —
   * це відбій чого? Оголошувати кінець того, що не починалось, означає
   * привчати читача, що наше слово «відбій» нічого не значить.
   */
  officialAlertSeen: boolean;
  /** Коли в живому пості вже сказали «цілей не бачимо, тривога триває». */
  quietNoticeAt: number | null;
}

export function beginWave(now: number): WaveState {
  return {
    startedAt: now,
    lastActiveAt: now,
    peakTargets: 0,
    oblasts: {},
    types: {},
    messageId: null,
    edits: 0,
    officialAlertSeen: false,
    quietNoticeAt: null,
  };
}

/**
 * Запам'ятовує, що в областях хвилі була офіційна тривога.
 *
 * Прапорець лише вмикається й ніколи не гасне: тривогу, яку оголошували,
 * треба закрити відбоєм, навіть якщо на момент перевірки її вже зняли.
 */
export function markOfficialAlert(state: WaveState, active: readonly string[]): WaveState {
  if (state.officialAlertSeen) return state;
  const set = new Set(active);
  const seen = Object.keys(state.oblasts).some((o) => set.has(o));
  return seen ? { ...state, officialAlertSeen: true } : state;
}

/** Вбирає черговий зріз у хвилю. Піки — саме максимуми, а не суми за час. */
export function updateWave(state: WaveState, snapshot: AirSnapshot, now: number): WaveState {
  const oblasts = { ...state.oblasts };
  const types: Partial<Record<ThreatType, number>> = { ...state.types };
  for (const [oblast, byType] of Object.entries(snapshot.oblasts)) {
    let sum = 0;
    for (const [type, n] of Object.entries(byType) as [ThreatType, number][]) {
      sum += n;
      types[type] = Math.max(types[type] ?? 0, n);
    }
    oblasts[oblast] = Math.max(oblasts[oblast] ?? 0, sum);
  }
  return {
    ...state,
    lastActiveAt: now,
    peakTargets: Math.max(state.peakTargets, snapshot.targets),
    oblasts,
    types,
  };
}

/**
 * Хвиля затихла — цілей не бачимо вже `quietMs`.
 *
 * Це НЕ умова відбою (його дає офіційне оголошення), а умова того, що можна
 * переписати живий пост на «цілей не бачимо». Пауза потрібна, бо набір OSINT
 * блимає: одна порожня вибірка не означає чистого неба.
 */
export const WAVE_QUIET_MS = 20 * 60 * 1000;
export function waveEnded(state: WaveState, now: number, quietMs = WAVE_QUIET_MS): boolean {
  return now - state.lastActiveAt >= quietMs;
}

/**
 * Коли хвилю кидають без відбою.
 *
 * Є області, де офіційна тривога триває добами. Чекати на її зняття вічно
 * означало б тримати хвилю відкритою назавжди, а відбій за ту ніч так і не
 * вийшов би. Через дванадцять годин тиші хвиля просто закривається — мовчки.
 * Мовчки, а не постом: «відбою не було» краще сказати нічим, ніж постом, який
 * прочитають як відбій.
 */
export const WAVE_ABANDON_MS = 12 * 60 * 60 * 1000;

const TYPE_PLURAL: Record<ThreatType, string> = {
  shahed: "шахеди",
  reactive: "реактивні шахеди",
  cruise: "крилаті",
  missile: "ракети",
  ballistic: "балістика",
  kab: "КАБи",
  recon: "розвідники",
  aircraft: "борти",
  unknown: "невпізнані",
};

/**
 * «Відбій» зі зведенням хвилі.
 *
 * Це пост, який справді пересилають: уранці людина хоче не 70 повідомлень
 * уночі, а один рядок — скільки тривало, де було найгарячіше. І він же —
 * єдине місце, де канал прямо каже межу: офіційний відбій дають Повітряні
 * Сили, а тут — лише те, що перестали бачити цілі.
 */
export function renderAllClear(state: WaveState, endedAt: number): string {
  const top = Object.entries(state.oblasts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const types = (Object.entries(state.types) as [ThreatType, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${TYPE_PLURAL[t]} — до ${n}`);

  const regions = Object.keys(state.oblasts).length;
  return [
    // Заголовок мусить казати, ЧИЙ це відбій. «У небі чисто» читалося б як
    // наша власна оцінка — а саме її ціна тут і є питанням життя.
    "🟢 <b>Відбій — офіційно</b>",
    "",
    `Хвиля тривала <b>${formatDuration(endedAt - state.startedAt)}</b>.`,
    `Пік: <b>${state.peakTargets}</b> цілей одночасно, зачепило <b>${regions}</b> ${regions === 1 ? "область" : "областей"}.`,
    ...(types.length ? ["", `Типи: ${types.join(", ")}`] : []),
    ...(top.length ? ["", "Найгарячіше було:"] : []),
    ...top.map(([name, n]) => `📍 <b>${name}</b> — до ${n} одночасно`),
    "",
    "<i>відбій оголошено офіційно в усіх областях, яких торкалася хвиля. Тривога може повернутись — не вимикайте сповіщення.</i>",
  ].join("\n");
}

/**
 * Проміжний стан: цілей не бачимо, але тривога ТРИВАЄ.
 *
 * Найважливіший текст у всьому каналі. Саме тут людину найлегше вбити
 * необережним словом: у неї на екрані пост із переліком цілей, яких уже
 * немає, і спокуса прочитати тишу як «можна виходити». Тому живий пост у цей
 * момент переписується на чесний стан — і прямо каже, що це НЕ відбій.
 */
export function renderQuietHold(
  state: WaveState,
  stillAlertingIn: readonly string[],
  now: number,
): string {
  const quietFor = formatDuration(now - state.lastActiveAt);
  return [
    "🟡 <b>Цілей не бачимо — але тривога триває</b>",
    "",
    `Востаннє фіксували ціль ${quietFor} тому. Пік хвилі: <b>${state.peakTargets}</b> одночасно.`,
    "",
    `🔴 Офіційна тривога ще діє: <b>${stillAlertingIn.join(", ")}</b>`,
    "",
    "<b>Це не відбій.</b> Відбій ми дамо лише після офіційного оголошення — " +
      "не виходьте з укриття за цим постом.",
  ].join("\n");
}

/* ─── 3. Підсумок доби ──────────────────────────────────────────────────── */

export interface DayStats {
  /** Київська доба, `РРРР-ММ-ДД`. */
  date: string;
  waves: number;
  peakTargets: number;
  /** Скільки хвилин за добу в небі було хоч щось. */
  loudMinutes: number;
  oblasts: Record<string, number>;
  types: Partial<Record<ThreatType, number>>;
}

export function emptyDay(date: string): DayStats {
  return { date, waves: 0, peakTargets: 0, loudMinutes: 0, oblasts: {}, types: {} };
}

/** Вбирає зріз у добову статистику. `minutes` — крок планувальника. */
export function accrueDay(day: DayStats, snapshot: AirSnapshot, minutes: number): DayStats {
  const oblasts = { ...day.oblasts };
  const types: Partial<Record<ThreatType, number>> = { ...day.types };
  for (const [oblast, byType] of Object.entries(snapshot.oblasts)) {
    let sum = 0;
    for (const [type, n] of Object.entries(byType) as [ThreatType, number][]) {
      sum += n;
      types[type] = Math.max(types[type] ?? 0, n);
    }
    oblasts[oblast] = Math.max(oblasts[oblast] ?? 0, sum);
  }
  return {
    ...day,
    peakTargets: Math.max(day.peakTargets, snapshot.targets),
    loudMinutes: day.loudMinutes + (snapshot.targets > 0 ? minutes : 0),
    oblasts,
    types,
  };
}

/**
 * Ранковий підсумок доби.
 *
 * `null` — доба була тиха. Порожній підсумок «за добу 0 цілей» щоранку
 * перетворює канал на будильник ні про що; тиха ніч не потребує поста.
 */
export function renderDigest(day: DayStats): string | null {
  const regions = Object.keys(day.oblasts).length;
  if (day.peakTargets === 0 && regions === 0) return null;

  const top = Object.entries(day.oblasts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const types = (Object.entries(day.types) as [ThreatType, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${TYPE_PLURAL[t]} — до ${n}`);

  return [
    `📊 <b>Минула доба у небі</b> · ${day.date}`,
    "",
    `Хвиль: <b>${day.waves}</b> · у небі щось було <b>${formatDuration(day.loudMinutes * 60000)}</b>`,
    `Пік: <b>${day.peakTargets}</b> цілей одночасно · областей зачеплено: <b>${regions}</b>`,
    ...(types.length ? ["", `Типи: ${types.join(", ")}`] : []),
    ...(top.length ? ["", "Найбільше діставалося:"] : []),
    ...top.map(([name, n], i) => `${i + 1}. <b>${name}</b> — до ${n} одночасно`),
    "",
    "<i>пік — це найбільша кількість, яку бачили ОДНОЧАСНО, а не сума за добу: тих самих цілей двічі не рахуємо</i>",
  ].join("\n");
}

/**
 * Критичні типи, яких раніше не було.
 *
 * Вирішує, коли хвиля заслуговує НОВОГО поста, а не тихого редагування
 * старого. Поява балістики над областю, де щойно були самі шахеди, — це подія,
 * про яку в стрічці мають побачити окремим повідомленням; правка тексту в
 * пості, який уже пролистали, тут рівносильна мовчанню.
 */
export function newCriticalTypes(prev: AirSnapshot | undefined, cur: AirSnapshot): ThreatType[] {
  const critical: ThreatType[] = ["ballistic", "missile", "cruise", "kab"];
  const before = new Set<ThreatType>();
  for (const m of Object.values(prev?.oblasts ?? {})) {
    for (const t of Object.keys(m) as ThreatType[]) before.add(t);
  }
  const seen = new Set<ThreatType>();
  for (const m of Object.values(cur.oblasts)) {
    for (const t of Object.keys(m) as ThreatType[]) seen.add(t);
  }
  return critical.filter((t) => seen.has(t) && !before.has(t));
}
