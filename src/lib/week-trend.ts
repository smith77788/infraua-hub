/**
 * Тижневий тренд — «ваш район цього тижня».
 *
 * Ритм (`threat-rhythm`) відповідає на «коли зазвичай», але не на «стало гірше
 * чи легше». А саме це питання люди ставлять одне одному щотижня: «цей тиждень
 * якийсь тихіший» — і не мають чим його перевірити, крім відчуття. Один рядок
 * «цього тижня 42 цілі, на третину більше за минулий, найгарячіший день —
 * вівторок» замінює це відчуття числом.
 *
 * Дані — денні підсумки на область; тримаємо коротке вікно (два тижні), щоб
 * порівняти поточні сім днів із попередніми. Плоско й серіалізовно: лягає
 * стійкою позначкою.
 *
 * Чиста логіка: дати у форматі `РРРР-ММ-ДД` (лексикографічно = хронологічно),
 * день тижня — з `Date`, годинника всередині немає.
 */

/** Область → (київська доба → сума цілей). */
export type WeekTrend = Record<string, Record<string, number>>;

/** Скільки днів історії тримаємо: два тижні на порівняння тиждень-до-тижня. */
export const WEEK_TREND_WINDOW_DAYS = 14;

const DOW_LABEL = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];

function dowLabel(date: string): string {
  // Парсимо як UTC-північ, щоб день тижня не поплив від зони запуску.
  const d = new Date(`${date}T00:00:00Z`);
  const idx = d.getUTCDay();
  return DOW_LABEL[idx] ?? "";
}

/** Список останніх N дат (включно з `today`), від найдавнішої до `today`. */
function lastDates(today: string, n: number): string[] {
  const base = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return [];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Додає денну суму цілей для області й підрізає вікно до двох тижнів. */
export function accrueDaily(
  trend: WeekTrend,
  oblast: string,
  date: string,
  count: number,
): WeekTrend {
  if (!oblast || !/^\d{4}-\d{2}-\d{2}$/.test(date) || count <= 0) return trend;
  const days = { ...(trend[oblast] ?? {}) };
  days[date] = (days[date] ?? 0) + count;

  // Підрізаємо все, старше за вікно від найсвіжішої відомої дати.
  const newest = Object.keys(days).sort().at(-1)!;
  const cutoff = lastDates(newest, WEEK_TREND_WINDOW_DAYS)[0];
  const pruned: Record<string, number> = {};
  for (const [d, c] of Object.entries(days)) if (cutoff == null || d >= cutoff) pruned[d] = c;

  return { ...trend, [oblast]: pruned };
}

export interface WeekSummary {
  oblast: string;
  thisWeek: number;
  lastWeek: number;
  /** Зміна у відсотках проти минулого тижня (`null`, коли минулого ще немає). */
  deltaPct: number | null;
  /** Напрям тренду для людини. */
  direction: "up" | "down" | "flat" | "new";
  /** Найгарячіший день поточного тижня (назва) або `null`. */
  busiestDay: string | null;
  busiestDayCount: number;
  label: string;
}

/**
 * Порівнює поточні сім днів (включно з `today`) з попередніми сімома.
 *
 * Тренд оголошується стриманим порогом ±20%: коливання менше — це «приблизно
 * як минулого тижня», а не «зросло», інакше кожен шум читався б як загострення.
 */
export function summarizeWeek(trend: WeekTrend, oblast: string, today: string): WeekSummary {
  const days = trend[oblast] ?? {};
  const window = lastDates(today, 14);
  const prev7 = window.slice(0, 7);
  const curr7 = window.slice(7);

  const sum = (dates: string[]): number => dates.reduce((n, d) => n + (days[d] ?? 0), 0);
  const thisWeek = sum(curr7);
  const lastWeek = sum(prev7);

  let busiestDay: string | null = null;
  let busiestDayCount = 0;
  for (const d of curr7) {
    const c = days[d] ?? 0;
    if (c > busiestDayCount) {
      busiestDayCount = c;
      busiestDay = dowLabel(d);
    }
  }

  let deltaPct: number | null = null;
  let direction: WeekSummary["direction"];
  if (lastWeek === 0) {
    direction = thisWeek === 0 ? "flat" : "new";
  } else {
    deltaPct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
    direction = deltaPct >= 20 ? "up" : deltaPct <= -20 ? "down" : "flat";
  }

  const label =
    thisWeek === 0
      ? "цього тижня над районом було тихо"
      : direction === "up"
        ? `цього тижня ${thisWeek} — активніше за минулий на ${deltaPct}%`
        : direction === "down"
          ? `цього тижня ${thisWeek} — тихіше за минулий на ${Math.abs(deltaPct!)}%`
          : direction === "new"
            ? `цього тижня ${thisWeek} (минулого — без активності)`
            : `цього тижня ${thisWeek} — приблизно як минулого`;

  return {
    oblast,
    thisWeek,
    lastWeek,
    deltaPct,
    direction,
    busiestDay,
    busiestDayCount,
    label,
  };
}
