/**
 * Щоденник тривог: скільки це вже триває особисто для вас.
 *
 * ## Навіщо це в моніторі
 *
 * Люди не помічають накопиченого. «Ніч як ніч» — а за місяць виходить
 * тридцять годин під тривогою й сімнадцять розбуджених ночей. Це число не
 * рятує від шахеда, але воно єдине, що перетворює щоденну втому на щось
 * назване — і саме тому ним діляться.
 *
 * Тут це має й пряме продуктове значення: підсумок — єдина річ у боті, яку
 * людина ПЕРЕСИЛАЄ сама, без прохання. Канал і сповіщення пересилають рідко:
 * вони про зараз. Підсумок — про неї.
 *
 * ## Що рахується, а що ні
 *
 * Рахуються ПОДІЇ, які людина справді бачила: надіслані їй сповіщення й
 * офіційні тривоги в її областях. Не «цілі в небі країни» — з тим числом вона
 * ніяк не пов'язана, і підсовувати його як особисте було б підміною.
 *
 * Час під тривогою рахується від початку офіційної тривоги до відбою, і лише
 * для тих областей, де в людини є місце. Це вимір, а не оцінка.
 */

import { formatDuration, kyivDate } from "./kyiv";

export interface DiaryDay {
  /** Київська доба, `РРРР-ММ-ДД`. */
  date: string;
  /** Скільки разів за добу ми будили цю людину. */
  alerts: number;
  /** Скільки з них були «в укриття». */
  shelterAlerts: number;
  /** Офіційних тривог у її областях. */
  officialAlarms: number;
  /** Хвилин під офіційною тривогою. */
  alarmMinutes: number;
  /** Чи була тривога вночі (23:00–07:00) — тобто чи розбудили. */
  nightDisturbed: boolean;
}

export interface Diary {
  /** Останні дні, найновіший перший. Довша історія не потрібна нікому. */
  days: DiaryDay[];
  since: string;
}

/** Скільки діб тримаємо. Місяць — рівно стільки, скільки люди й порівнюють. */
export const DIARY_DAYS = 31;

export function emptyDiary(at: Date): Diary {
  return { days: [], since: kyivDate(at) };
}

function todayOf(diary: Diary, date: string): DiaryDay {
  return (
    diary.days.find((d) => d.date === date) ?? {
      date,
      alerts: 0,
      shelterAlerts: 0,
      officialAlarms: 0,
      alarmMinutes: 0,
      nightDisturbed: false,
    }
  );
}

function withDay(diary: Diary, day: DiaryDay): Diary {
  const rest = diary.days.filter((d) => d.date !== day.date);
  const days = [day, ...rest].sort((a, b) => b.date.localeCompare(a.date)).slice(0, DIARY_DAYS);
  return { ...diary, days };
}

export interface DiaryEvent {
  kind: "alert" | "alarm";
  /** Для сповіщення: чи це було «в укриття». */
  shelter?: boolean;
  /** Для тривоги: скільки вона тривала, хв. */
  minutes?: number;
  /** Чи це сталося вночі. */
  night?: boolean;
}

export function recordEvent(diary: Diary, event: DiaryEvent, at: Date): Diary {
  const date = kyivDate(at);
  const day = todayOf(diary, date);
  if (event.kind === "alert") {
    return withDay(diary, {
      ...day,
      alerts: day.alerts + 1,
      shelterAlerts: day.shelterAlerts + (event.shelter ? 1 : 0),
      nightDisturbed: day.nightDisturbed || Boolean(event.night),
    });
  }
  return withDay(diary, {
    ...day,
    officialAlarms: day.officialAlarms + 1,
    alarmMinutes: day.alarmMinutes + Math.max(0, Math.round(event.minutes ?? 0)),
    nightDisturbed: day.nightDisturbed || Boolean(event.night),
  });
}

export interface DiaryTotals {
  days: number;
  alerts: number;
  shelterAlerts: number;
  alarms: number;
  alarmMinutes: number;
  nightsDisturbed: number;
  /** Найгучніша доба за період. */
  worstDate: string | null;
  worstAlarms: number;
}

export function totals(diary: Diary, lastDays = DIARY_DAYS): DiaryTotals {
  const slice = diary.days.slice(0, lastDays);
  let worstDate: string | null = null;
  let worstAlarms = 0;
  for (const d of slice) {
    if (d.officialAlarms > worstAlarms) {
      worstAlarms = d.officialAlarms;
      worstDate = d.date;
    }
  }
  return {
    days: slice.length,
    alerts: slice.reduce((n, d) => n + d.alerts, 0),
    shelterAlerts: slice.reduce((n, d) => n + d.shelterAlerts, 0),
    alarms: slice.reduce((n, d) => n + d.officialAlarms, 0),
    alarmMinutes: slice.reduce((n, d) => n + d.alarmMinutes, 0),
    nightsDisturbed: slice.filter((d) => d.nightDisturbed).length,
    worstDate,
    worstAlarms,
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

/**
 * Підсумок для людини.
 *
 * `null` — рахувати ще нема чого. Порожній підсумок («0 тривог за 0 днів») —
 * це не скромність, це повідомлення без змісту.
 *
 * Тон рівний. Спокуса написати «ви герой» тут велика й шкідлива: людина не
 * просила похвали за те, що над її домом літає, і фальш у цьому місці помітна
 * найгостріше.
 */
export function renderSummary(t: DiaryTotals, period: string): string | null {
  if (t.days === 0 || (t.alerts === 0 && t.alarms === 0)) return null;
  const lines = [`📔 <b>${period}</b>`, ""];

  if (t.alarms > 0) {
    lines.push(
      `Тривог у ваших областях: <b>${t.alarms}</b>`,
      `Під тривогою: <b>${formatDuration(t.alarmMinutes * 60_000)}</b>`,
    );
  }
  if (t.alerts > 0) {
    lines.push(
      `Ми попереджали вас: <b>${t.alerts}</b> ${plural(t.alerts, "раз", "рази", "разів")}` +
        (t.shelterAlerts > 0 ? ` · з них «в укриття»: <b>${t.shelterAlerts}</b>` : ""),
    );
  }
  if (t.nightsDisturbed > 0) {
    lines.push(
      `Ночей, які це зачепило: <b>${t.nightsDisturbed}</b> ${plural(t.nightsDisturbed, "ніч", "ночі", "ночей")}`,
    );
  }
  if (t.worstDate && t.worstAlarms > 1) {
    lines.push("", `Найгучніше було <b>${t.worstDate}</b> — ${t.worstAlarms} тривог.`);
  }
  lines.push("", "<i>Рахуємо лише те, що стосувалось ваших місць.</i>");
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
