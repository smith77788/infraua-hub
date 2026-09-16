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
 * ## Що тут навмисно НЕ рахується
 *
 * Немає «скільки цілей пролетіло над вами» і «наскільки близько було». Це
 * дані про удари по конкретній адресі, і зібрані в одному місці вони цінні
 * рівно для того, хто ці удари планує. Лічильник тривог такої властивості не
 * має: тривога оголошується на цілу область і публічна за визначенням.
 *
 * ## Чому по місяцях
 *
 * Запис живе в підписнику, тобто в кожного свій. Нескінченна історія росла б
 * разом зі стажем, і найактивніші користувачі коштували б найдорожче. Місяців
 * тримаємо небагато, а старі згортаються самі.
 */

/** Скільки місяців тримаємо. Рік — це вже історія, а не «мій місяць». */
export const KEEP_MONTHS = 3;

/**
 * Скільки випереджень памʼятаємо для середнього.
 *
 * Не всі: масив у сховищі росте з кожною тривогою, а середнє по останніх
 * двадцяти чесніше за середнє по всіх — воно показує, як система працює
 * ЗАРАЗ, а не як працювала торік.
 */
export const KEEP_LEADS = 20;

export interface MonthStats {
  /** Ключ місяця у вигляді `2026-09` — сортується як рядок. */
  month: string;
  /** Скільки разів ми надіслали сповіщення. */
  alerts: number;
  /** Скільки хвилин точка була під офіційною тривогою. */
  alarmMinutes: number;
  /** Найдовша безперервна тривога, хв. */
  longestAlarmMin: number;
  /** Скільки разів ми сказали РАНІШЕ за сирену. */
  aheadCount: number;
  /** Останні випередження в хвилинах — для середнього. */
  leads: number[];
}

export interface PersonalStats {
  months: MonthStats[];
}

/** Ключ місяця з мітки часу, за київським часом. */
export function monthKey(at: number, timeZone = "Europe/Kyiv"): string {
  const d = new Date(at);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).format(d);
  return parts.slice(0, 7);
}

function emptyMonth(month: string): MonthStats {
  return { month, alerts: 0, alarmMinutes: 0, longestAlarmMin: 0, aheadCount: 0, leads: [] };
}

/**
 * Дістати місяць для запису, згорнувши застаріле.
 *
 * Згортання саме тут, а не окремим прибиральником: інакше воно б залежало від
 * того, чи хтось його запустив, і сховище тихо росло б у тих, хто не заходить.
 */
function withMonth(stats: PersonalStats | undefined, month: string): PersonalStats {
  const months = (stats?.months ?? []).filter((m) => m.month !== month);
  months.push(stats?.months.find((m) => m.month === month) ?? emptyMonth(month));
  months.sort((a, b) => a.month.localeCompare(b.month));
  return { months: months.slice(-KEEP_MONTHS) };
}

function patch(
  stats: PersonalStats | undefined,
  at: number,
  change: (m: MonthStats) => MonthStats,
): PersonalStats {
  const key = monthKey(at);
  const next = withMonth(stats, key);
  return {
    months: next.months.map((m) => (m.month === key ? change(m) : m)),
  };
}

/** Записати надіслане сповіщення. */
export function recordAlert(stats: PersonalStats | undefined, at: number): PersonalStats {
  return patch(stats, at, (m) => ({ ...m, alerts: m.alerts + 1 }));
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
  return patch(stats, at, (m) => ({
    ...m,
    aheadCount: leadMin > 0 ? m.aheadCount + 1 : m.aheadCount,
    leads: [...m.leads, Math.max(0, Math.round(leadMin))].slice(-KEEP_LEADS),
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
  return patch(stats, at, (m) => ({
    ...m,
    alarmMinutes: m.alarmMinutes + add,
    longestAlarmMin: Math.max(m.longestAlarmMin, run),
  }));
}

export interface StatsSummary {
  month: string;
  alerts: number;
  alarmHours: number;
  longestAlarmMin: number;
  aheadCount: number;
  /** Середнє випередження, хв. `null` — вимірів ще немає. */
  avgLeadMin: number | null;
}

export function summarizeMonth(stats: PersonalStats | undefined, at: number): StatsSummary | null {
  const key = monthKey(at);
  const m = stats?.months.find((x) => x.month === key);
  if (!m) return null;
  const avg = m.leads.length
    ? Math.round((m.leads.reduce((s, x) => s + x, 0) / m.leads.length) * 10) / 10
    : null;
  return {
    month: m.month,
    alerts: m.alerts,
    alarmHours: Math.round((m.alarmMinutes / 60) * 10) / 10,
    longestAlarmMin: m.longestAlarmMin,
    aheadCount: m.aheadCount,
    avgLeadMin: avg,
  };
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

function duration(min: number): string {
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} год ${String(m).padStart(2, "0")} хв` : `${h} год`;
}

/**
 * Місяць людини одним екраном.
 *
 * Про випередження кажемо ЧЕСНО в обидва боки: коли його не було — так і
 * пишемо. Статистика, яка показує лише вдале, — це вже не вимір.
 */
export function renderStats(summary: StatsSummary | null): string {
  if (!summary || summary.alerts === 0) {
    return [
      "📊 <b>Ваш місяць</b>",
      "",
      "Поки що тихо: цього місяця ми вас не турбували жодного разу.",
      "",
      "<i>Тут зʼявиться, скільки тривог ви пережили, скільки годин вони тривали і на скільки ми випередили сирену.</i>",
    ].join("\n");
  }

  const name = MONTH_NAME[summary.month.slice(5)] ?? summary.month;
  const lines = [`📊 <b>Ваш ${name}</b>`, "", `Сповіщень від нас: <b>${summary.alerts}</b>`];
  if (summary.alarmHours > 0) {
    lines.push(
      `Під тривогою: <b>${summary.alarmHours}</b> ${hoursWord(summary.alarmHours)}` +
        (summary.longestAlarmMin > 0 ? ` · найдовша ${duration(summary.longestAlarmMin)}` : ""),
    );
  }
  lines.push("");
  if (summary.avgLeadMin !== null && summary.aheadCount > 0) {
    lines.push(
      `⏱ Ми сказали раніше за сирену <b>${summary.aheadCount}</b> раз(и) — у середньому на <b>${summary.avgLeadMin}</b> хв.`,
    );
  } else {
    // Чесно в обидва боки: інакше це вже не вимір, а реклама.
    lines.push("⏱ Випередити сирену цього місяця не вдалося жодного разу.");
  }
  lines.push("");
  lines.push(
    "<i>Рахуються лише тривоги й наші сповіщення. Де саме пролітали цілі — не зберігаємо.</i>",
  );
  return lines.join("\n");
}
