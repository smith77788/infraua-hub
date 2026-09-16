/**
 * Особиста статистика: скільки це коштувало саме вам — і скільки ми дали.
 *
 * ## Навіщо
 *
 * Радар щодня щось обіцяє: «попередимо раніше за сирену», «не розбудимо
 * дарма». Обіцянку неможливо оскаржити, і саме тому їй із часом перестають
 * вірити. Заміряне число — можна: «за вересень ми випередили сирену
 * чотирнадцять разів, у середньому на 6 хвилин» або, чесно, «жодного разу».
 *
 * Друга причина важливіша за першу. Людина, яка пережила сорок тривог за
 * місяць, не памʼятає жодної окремо — вони злипаються в суцільний фон, і
 * здається, що «було як завжди». Побачити «18 годин під тривогою, найдовша
 * 4 год 20 хв» — це вперше побачити власний місяць цифрою. Такі речі люди
 * пересилають, і це єдиний чесний спосіб зростання в цій ніші.
 *
 * ## Чому запис по ДОБАХ, а підсумок по місяцях
 *
 * Місяць виводиться з діб, доби з місяця — ні. Тиждень, «скільки ночей нас
 * розбудили», «найгучніша доба» — усе це існує лише там, де збережено добу.
 * Тому зберігається дрібне, а показується велике: одна модель, з якої можна
 * зібрати і «ваш вересень», і понеділковий підсумок тижня.
 *
 * ## Що тут навмисно НЕ рахується
 *
 * Немає «скільки цілей пролетіло над вами» і «наскільки близько було». Це
 * дані про удари по конкретній адресі, і зібрані в одному місці вони цінні
 * рівно для того, хто ці удари планує. Лічильник тривог такої властивості не
 * має: тривога оголошується на цілу область і публічна за визначенням.
 *
 * ## Чому історія коротка
 *
 * Запис живе в підписнику, тобто в кожного свій. Нескінченна історія росла б
 * разом зі стажем, і найактивніші користувачі коштували б найдорожче. Тримаємо
 * рівно стільки діб, скільки треба для «мого місяця», а старі згортаються самі.
 * Порожні доби не записуються взагалі — у того, кого не турбували, статистика
 * не займає нічого.
 */

import { kyivDate, kyivHour } from "./kyiv";

/**
 * Скільки діб тримаємо.
 *
 * Тридцять одна — найдовший місяць. Більше не треба: «мій місяць» — це цей
 * місяць, а не історія за рік.
 */
export const KEEP_DAYS = 31;

export interface DayStats {
  /** Київська доба, `РРРР-ММ-ДД` — сортується як рядок. */
  date: string;
  /** Скільки разів ми надіслали сповіщення. */
  alerts: number;
  /** Скільки з них були «в укриття». */
  shelterAlerts: number;
  /** Офіційних тривог у місцях людини. */
  alarms: number;
  /** Хвилин під офіційною тривогою. */
  alarmMinutes: number;
  /** Найдовша безперервна тривога цієї доби, хв. */
  longestAlarmMin: number;
  /** Скільки разів ми сказали РАНІШЕ за сирену (випередження > 0). */
  aheadCount: number;
  /**
   * Скільки випереджень виміряно взагалі — включно з нульовими.
   *
   * Окремо від `aheadCount`, бо це знаменник середнього: рахувати середнє лише
   * по вдалих означало б рекламувати, а не міряти.
   */
  leadCount: number;
  /**
   * Сума випереджень, хв.
   *
   * Сума, а не масив вимірів: середнє з неї виходить точне, а місця вона
   * займає стільки ж, скільки одне число. Масив останніх N був би і більшим, і
   * менш точним — а «свіжість» тут уже забезпечена тим, що доби старші за
   * місяць згортаються.
   */
  leadSumMin: number;
  /** Чи зачепило ніч (23:00–06:59) — тобто чи розбудили. */
  nightDisturbed: boolean;
}

export interface PersonalStats {
  days: DayStats[];
}

/** Ключ місяця у вигляді `2026-09`, за київським часом. */
export function monthKey(at: number): string {
  return kyivDate(new Date(at)).slice(0, 7);
}

function emptyDay(date: string): DayStats {
  return {
    date,
    alerts: 0,
    shelterAlerts: 0,
    alarms: 0,
    alarmMinutes: 0,
    longestAlarmMin: 0,
    aheadCount: 0,
    leadCount: 0,
    leadSumMin: 0,
    nightDisturbed: false,
  };
}

/**
 * Змінити добу, згорнувши застаріле.
 *
 * Згортання саме тут, а не окремим прибиральником: інакше воно б залежало від
 * того, чи хтось його запустив, і сховище тихо росло б у тих, хто не заходить.
 */
function patch(
  stats: PersonalStats | undefined,
  at: number,
  change: (d: DayStats) => DayStats,
): PersonalStats {
  const date = kyivDate(new Date(at));
  const rest = (stats?.days ?? []).filter((d) => d.date !== date);
  const current = stats?.days.find((d) => d.date === date) ?? emptyDay(date);
  const days = [change(current), ...rest]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, KEEP_DAYS);
  return { days };
}

export interface AlertFacts {
  /** Чи це було «в укриття», а не «увага». */
  shelter?: boolean;
}

/**
 * Записати надіслане сповіщення.
 *
 * Ніч визначається з самої мітки часу, а не передається окремо: «розбудили» —
 * властивість години, і давати це знання ззовні означало б дозволити двом
 * місцям коду розійтися в тому, що таке ніч.
 */
export function recordAlert(
  stats: PersonalStats | undefined,
  at: number,
  facts: AlertFacts = {},
): PersonalStats {
  const night = isNightAt(at);
  return patch(stats, at, (d) => ({
    ...d,
    alerts: d.alerts + 1,
    shelterAlerts: d.shelterAlerts + (facts.shelter ? 1 : 0),
    nightDisturbed: d.nightDisturbed || night,
  }));
}

function isNightAt(at: number): boolean {
  const h = kyivHour(new Date(at));
  return h >= 23 || h < 7;
}

/**
 * Записати випередження сирени.
 *
 * Нуль теж записується як подія: «попередили одночасно з сиреною» — це не
 * провал і не успіх, але викинути такі випадки означало б рахувати середнє
 * лише по вдалих, а це вже не вимір, а реклама.
 */
export function recordLead(
  stats: PersonalStats | undefined,
  leadMin: number,
  at: number,
): PersonalStats {
  const lead = Math.max(0, Math.round(leadMin));
  return patch(stats, at, (d) => ({
    ...d,
    aheadCount: lead > 0 ? d.aheadCount + 1 : d.aheadCount,
    leadCount: d.leadCount + 1,
    leadSumMin: d.leadSumMin + lead,
  }));
}

/**
 * Додати хвилини під тривогою.
 *
 * `runMinutes` — тривалість поточної безперервної тривоги, а не приріст: із
 * неї береться максимум для «найдовшої». Приріст рахується окремо, бо тик
 * планувальника нерівномірний.
 */
export function recordAlarmMinutes(
  stats: PersonalStats | undefined,
  addMinutes: number,
  runMinutes: number,
  at: number,
): PersonalStats {
  const add = Math.max(0, Math.round(addMinutes));
  const run = Math.max(0, Math.round(runMinutes));
  const night = isNightAt(at);
  return patch(stats, at, (d) => ({
    ...d,
    alarmMinutes: d.alarmMinutes + add,
    longestAlarmMin: Math.max(d.longestAlarmMin, run),
    nightDisturbed: d.nightDisturbed || night,
  }));
}

/** Порахувати початок тривоги (для лічильника «скільки їх було»). */
export function recordAlarmStart(stats: PersonalStats | undefined, at: number): PersonalStats {
  return patch(stats, at, (d) => ({ ...d, alarms: d.alarms + 1 }));
}

export interface StatsSummary {
  /** Період підсумку: `2026-09` для місяця, `тиждень` — для тижневого. */
  period: string;
  alerts: number;
  shelterAlerts: number;
  alarms: number;
  alarmHours: number;
  longestAlarmMin: number;
  aheadCount: number;
  /** Скільки випереджень виміряно взагалі — знаменник середнього. */
  leadCount: number;
  /** Середнє випередження, хв. `null` — вимірів ще немає. */
  avgLeadMin: number | null;
  /** Скільки ночей це зачепило. */
  nightsDisturbed: number;
  /** Найгучніша доба періоду — і скільки тривог у ній. */
  worstDate: string | null;
  worstAlarms: number;
}

function summarize(days: readonly DayStats[], period: string): StatsSummary | null {
  if (days.length === 0) return null;
  let worstDate: string | null = null;
  let worstAlarms = 0;
  for (const d of days) {
    if (d.alarms > worstAlarms) {
      worstAlarms = d.alarms;
      worstDate = d.date;
    }
  }
  const total = (pick: (d: DayStats) => number) => days.reduce((n, d) => n + pick(d), 0);
  const alerts = total((d) => d.alerts);
  const aheadCount = total((d) => d.aheadCount);
  const leadCount = total((d) => d.leadCount);
  const leadSum = total((d) => d.leadSumMin);
  return {
    period,
    alerts,
    shelterAlerts: total((d) => d.shelterAlerts),
    alarms: total((d) => d.alarms),
    alarmHours: Math.round((total((d) => d.alarmMinutes) / 60) * 10) / 10,
    longestAlarmMin: days.reduce((n, d) => Math.max(n, d.longestAlarmMin), 0),
    aheadCount,
    leadCount,
    avgLeadMin: leadCount > 0 ? Math.round((leadSum / leadCount) * 10) / 10 : null,
    nightsDisturbed: days.filter((d) => d.nightDisturbed).length,
    worstDate,
    worstAlarms,
  };
}

/** Підсумок за календарний місяць мітки часу. */
export function summarizeMonth(stats: PersonalStats | undefined, at: number): StatsSummary | null {
  const key = monthKey(at);
  const days = (stats?.days ?? []).filter((d) => d.date.startsWith(key));
  return summarize(days, key);
}

/** Підсумок за останні сім діб, включно з поточною. */
export function summarizeWeek(stats: PersonalStats | undefined, at: number): StatsSummary | null {
  const from = kyivDate(new Date(at - 6 * 24 * 60 * 60 * 1000));
  const to = kyivDate(new Date(at));
  const days = (stats?.days ?? []).filter((d) => d.date >= from && d.date <= to);
  return summarize(days, "тиждень");
}

const MONTH_NAME: Record<string, string> = {
  "01": "січень",
  "02": "лютий",
  "03": "березень",
  "04": "квітень",
  "05": "травень",
  "06": "червень",
  "07": "липень",
  "08": "серпень",
  "09": "вересень",
  "10": "жовтень",
  "11": "листопад",
  "12": "грудень",
};

function hoursWord(h: number): string {
  const n = Math.floor(h);
  if (n % 10 === 1 && n % 100 !== 11) return "година";
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return "години";
  return "годин";
}

function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function duration(min: number): string {
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} год ${String(m).padStart(2, "0")} хв` : `${h} год`;
}

/** Назва періоду в заголовку: «Ваш вересень» або «Ваш тиждень». */
function periodTitle(period: string): string {
  const month = MONTH_NAME[period.slice(5)];
  return month && /^\d{4}-\d{2}$/.test(period) ? `Ваш ${month}` : `Ваш ${period}`;
}

/**
 * Місяць (або тиждень) людини одним екраном.
 *
 * Про випередження кажемо ЧЕСНО в обидва боки: коли його не було — так і
 * пишемо. Статистика, яка показує лише вдале, — це вже не вимір.
 *
 * Тон рівний. Спокуса написати «ви герой» тут велика й шкідлива: людина не
 * просила похвали за те, що над її домом літає, і фальш у цьому місці помітна
 * найгостріше.
 */
export function renderStats(summary: StatsSummary | null): string {
  if (!summary || (summary.alerts === 0 && summary.alarms === 0)) {
    return [
      "📊 <b>Ваш місяць</b>",
      "",
      "Поки що тихо: цього місяця ми вас не турбували жодного разу.",
      "",
      "<i>Тут зʼявиться, скільки тривог ви пережили, скільки годин вони тривали і на скільки ми випередили сирену.</i>",
    ].join("\n");
  }

  const lines = [`📊 <b>${periodTitle(summary.period)}</b>`, ""];
  if (summary.alarms > 0) {
    lines.push(`Тривог у ваших місцях: <b>${summary.alarms}</b>`);
  }
  if (summary.alerts > 0) {
    lines.push(
      `Сповіщень від нас: <b>${summary.alerts}</b>` +
        (summary.shelterAlerts > 0 ? ` · з них «в укриття»: <b>${summary.shelterAlerts}</b>` : ""),
    );
  }
  if (summary.alarmHours > 0) {
    lines.push(
      `Під тривогою: <b>${summary.alarmHours}</b> ${hoursWord(summary.alarmHours)}` +
        (summary.longestAlarmMin > 0 ? ` · найдовша ${duration(summary.longestAlarmMin)}` : ""),
    );
  }
  if (summary.nightsDisturbed > 0) {
    lines.push(
      `Ночей, які це зачепило: <b>${summary.nightsDisturbed}</b> ${plural(summary.nightsDisturbed, "ніч", "ночі", "ночей")}`,
    );
  }
  lines.push("");
  if (summary.avgLeadMin !== null && summary.aheadCount > 0) {
    // «N із M» навмисно: середнє рахується по ВСІХ вимірах, включно з тими,
    // де випередити не вдалося. Показати лише вдалі — це вже не вимір.
    lines.push(
      `⏱ Раніше за сирену: <b>${summary.aheadCount}</b> ${plural(summary.aheadCount, "раз", "рази", "разів")} із ${summary.leadCount} · у середньому на <b>${summary.avgLeadMin}</b> хв.`,
    );
  } else {
    // Чесно в обидва боки: інакше це вже не вимір, а реклама.
    lines.push("⏱ Випередити сирену цього періоду не вдалося жодного разу.");
  }
  if (summary.worstDate && summary.worstAlarms > 1) {
    lines.push("", `Найгучніше було <b>${summary.worstDate}</b> — ${summary.worstAlarms} тривог.`);
  }
  lines.push("");
  lines.push(
    "<i>Рахуються лише тривоги у ваших місцях і наші сповіщення. Де саме пролітали цілі — не зберігаємо.</i>",
  );
  return lines.join("\n");
}

/**
 * Чи час надсилати тижневий підсумок.
 *
 * Понеділок уранці: у неділю ввечері його не читають, а в середу він уже ні
 * про що. Один раз на тиждень і рівно тоді, коли людина береться за телефон.
 */
export function weeklyDue(at: Date, lastSent: string | null, hourKyiv: number): boolean {
  if (hourKyiv < 10) return false;
  if (at.getUTCDay() !== 1) return false; // понеділок
  return lastSent !== kyivDate(at);
}
