/**
 * Коли історично тихо — щоб можна було спланувати сон і дорогу.
 *
 * ## Питання, на яке ніхто не відповідає
 *
 * «Зараз тихо» монітор каже. «Чи встигну я поспати» — ні. А саме це питання
 * людина ставить собі щовечора третій рік поспіль: лягати зараз чи чекати, бо
 * все одно піднімуть; їхати вранці чи перенести; ставити будильник на шосту
 * чи на восьму.
 *
 * Відповідь у даних уже є. Наліт — не випадковість: у нього є розклад, і він
 * стійкий тижнями. Ми накопичуємо активність по десятихвилинних відрізках, і
 * з них видно, які години доби в цій області справді спокійніші за інші.
 *
 * ## Чому це прогноз, а не обіцянка — і як це сказано
 *
 * Статистика минулого не зобовʼязує майбутнє. Найтихіша година може стати
 * найгучнішою сьогодні вночі, і якщо людина сприйме наше «спокійно» як
 * гарантію, вона вимкне звук — і не почує справжнього. Тому:
 *
 * • слово «історично» стоїть у самому рядку, а не в довідці;
 * • ми НЕ радимо вимикати сповіщення й ніде цього не пропонуємо;
 * • при малій вибірці мовчимо взагалі — див. `MIN_OBSERVED_DAYS`.
 *
 * Останнє важливіше за перші два. Профіль, зібраний за два дні, — це не
 * профіль, а два дні; видати його за розклад означало б вигадати впевненість
 * там, де її нема.
 */

/** Менше цього — мовчимо: це ще не розклад, а кілька днів. */
export const MIN_OBSERVED_DAYS = 7;

/** Відрізок накопичення — той самий, що й у сховищі активності. */
export const BUCKET_MS = 10 * 60 * 1000;

export interface ActivityBucket {
  /** Початок відрізка, ms. */
  at: number;
  /** Скільки цілей бачили в цьому відрізку. */
  targets: number;
}

export interface HourStat {
  /** Година доби за київським часом, 0..23. */
  hour: number;
  /** Середня кількість цілей у цю годину. */
  avgTargets: number;
  /** Частка відрізків, у які небо було порожнім, 0..1. */
  quietShare: number;
  /** Скільки відрізків лягло в цю годину — міра надійності. */
  samples: number;
}

export interface CalmProfile {
  hours: HourStat[];
  observedDays: number;
  /** `false` — вибірка замала, показувати нічого не можна. */
  reliable: boolean;
}

function kyivHour(at: number): number {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    hour12: false,
  }).format(new Date(at));
  return Number(s);
}

/**
 * Погодинний профіль із накопичених відрізків.
 *
 * Рахуємо дві різні речі, і це навмисно. Середня кількість цілей каже про
 * МАСШТАБ, а частка тихих відрізків — про ЙМОВІРНІСТЬ того, що тебе взагалі
 * потурбують. Людині, яка обирає час для сну, потрібна друга: одна ніч із
 * сорока цілями псує середнє, але не робить годину загалом неспокійною.
 */
export function buildCalmProfile(buckets: readonly ActivityBucket[]): CalmProfile {
  const byHour = new Map<number, { total: number; quiet: number; n: number }>();
  const days = new Set<string>();

  for (const b of buckets) {
    const h = kyivHour(b.at);
    const cur = byHour.get(h) ?? { total: 0, quiet: 0, n: 0 };
    cur.total += b.targets;
    if (b.targets === 0) cur.quiet += 1;
    cur.n += 1;
    byHour.set(h, cur);
    days.add(new Date(b.at).toISOString().slice(0, 10));
  }

  const hours: HourStat[] = [];
  for (let h = 0; h < 24; h++) {
    const c = byHour.get(h);
    if (!c || c.n === 0) continue;
    hours.push({
      hour: h,
      avgTargets: Math.round((c.total / c.n) * 10) / 10,
      quietShare: Math.round((c.quiet / c.n) * 100) / 100,
      samples: c.n,
    });
  }

  return { hours, observedDays: days.size, reliable: days.size >= MIN_OBSERVED_DAYS };
}

export interface CalmWindow {
  fromHour: number;
  toHour: number;
  quietShare: number;
}

/**
 * Найспокійніше вікно потрібної довжини.
 *
 * Шукаємо суцільний проміжок, а не окремі години: «тихо о 3-й і о 7-й» не
 * допомагає тому, хто хоче поспати шість годин поспіль. Вікно може переходити
 * через північ — саме там воно найчастіше й буває.
 */
export function calmestWindow(profile: CalmProfile, lengthHours = 6): CalmWindow | null {
  if (!profile.reliable || profile.hours.length < 24) return null;
  const byHour = new Map(profile.hours.map((h) => [h.hour, h]));
  let best: CalmWindow | null = null;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    let ok = true;
    for (let i = 0; i < lengthHours; i++) {
      const h = byHour.get((start + i) % 24);
      if (!h) {
        ok = false;
        break;
      }
      sum += h.quietShare;
    }
    if (!ok) continue;
    const share = sum / lengthHours;
    if (!best || share > best.quietShare) {
      best = {
        fromHour: start,
        toHour: (start + lengthHours) % 24,
        quietShare: Math.round(share * 100) / 100,
      };
    }
  }
  return best;
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * Рядок для людини.
 *
 * Слово «історично» стоїть у самому рядку, а не в довідці: рядок пересилають
 * скріншотом, і застереження має їхати разом із ним.
 */
export function renderCalmHours(profile: CalmProfile, lengthHours = 6): string {
  if (!profile.reliable) {
    return [
      "🌙 <b>Коли історично тихіше</b>",
      "",
      `Даних поки замало: зібрано ${profile.observedDays} дн. із потрібних ${MIN_OBSERVED_DAYS}.`,
      "",
      "<i>Профіль за кілька днів — це не розклад, а кілька днів. Видати його за розклад означало б вигадати впевненість, якої нема.</i>",
    ].join("\n");
  }

  const win = calmestWindow(profile, lengthHours);
  const loud = [...profile.hours].sort((a, b) => a.quietShare - b.quietShare)[0];
  const lines = ["🌙 <b>Коли історично тихіше</b>", ""];
  if (win) {
    lines.push(
      `Найспокійніший проміжок: <b>${hh(win.fromHour)}–${hh(win.toHour)}</b> — небо порожнє у ${Math.round(win.quietShare * 100)}% випадків.`,
    );
  }
  if (loud) {
    lines.push(
      `Найгучніша година: <b>${hh(loud.hour)}</b> — у середньому ${loud.avgTargets} цілей.`,
    );
  }
  lines.push("");
  lines.push(
    `<i>Це статистика за ${profile.observedDays} дн., а не прогноз погоди. Найтихіша година може стати найгучнішою сьогодні — тому сповіщення вимикати не варто, і ми цього не пропонуємо.</i>`,
  );
  return lines.join("\n");
}
