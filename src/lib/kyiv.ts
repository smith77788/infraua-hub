/**
 * Київський час — одне місце на весь проєкт.
 *
 * Зашите «UTC+2» було б помилкою двічі на рік: Україна переходить на літній
 * час, і нічний режим будив би людей на годину раніше або пізніше за обіцяне,
 * а добове зведення виходило б не тією датою. `Intl` знає правила зони; якщо
 * рантайм зібрано без повних даних ICU, падаємо на UTC — зміщення на годину
 * помітне, мовчазне падіння функції було б гіршим.
 */

const TZ = "Europe/Kyiv";

export function kyivHour(at: Date): number {
  try {
    const text = new Intl.DateTimeFormat("uk-UA", {
      timeZone: TZ,
      hour: "numeric",
      hour12: false,
    }).format(at);
    const n = Number(text.replace(/\D/g, ""));
    return Number.isFinite(n) ? n % 24 : at.getUTCHours();
  } catch {
    return at.getUTCHours();
  }
}

/** Дата у форматі `РРРР-ММ-ДД` за київською добою. */
export function kyivDate(at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * «3 год 20 хв» — для тривалості хвилі. Менше за хвилину — «менш ніж хвилина».
 *
 * Нечисло не перетворюється на «NaN год NaN хв», і це не косметика. Тривалість
 * рахується з відновленого зі сховища стану, куди поле могли додати пізніше за
 * сам запис: одне `undefined` — і в КАНАЛ іде «Хвиля тривала NaN год NaN хв».
 * Публічне обличчя продукту не має залежати від того, чи всі схеми зійшлися.
 *
 * «Невідомо» замість вигаданого числа: сказати «менш ніж хвилина» про хвилю,
 * тривалості якої ми не знаємо, — це не запобіжник, а тиха неправда.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "невідомо скільки";
  const min = Math.round(ms / 60000);
  if (min < 1) return "менш ніж хвилина";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} хв`;
  return m === 0 ? `${h} год` : `${h} год ${m} хв`;
}
