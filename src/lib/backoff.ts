/**
 * Відступ між повторними спробами, коли джерело не відповідає.
 *
 * Прогресивне довантаження опитує сервер щохвилини, доки покриття неповне.
 * Якщо Overpass недоступний, кожна спроба повертає нуль тайлів — і опитування
 * триває щохвилини вічно, навантажуючи джерело, яке саме зараз не в порядку,
 * і показуючи користувачеві прогрес, якого немає.
 *
 * Тому інтервал росте з кожною порожньою відповіддю, а стеля не дає йому
 * перетворитися на «ніколи»: джерело повертається, і система має це помітити
 * без перезавантаження сторінки.
 */

const BASE_MS = 60_000;
const CEILING_MS = 15 * 60_000;

export function backoffMs(consecutiveEmpty: number): number {
  if (consecutiveEmpty <= 0) return BASE_MS;
  return Math.min(CEILING_MS, BASE_MS * 2 ** Math.min(consecutiveEmpty, 8));
}

/**
 * Скільки порожніх відповідей поспіль означає «джерело недоступне», а не
 * «просто зараз нічого немає». Одна невдача — звичайна справа.
 */
export const UNAVAILABLE_AFTER = 2;

export function sourceUnavailable(consecutiveEmpty: number): boolean {
  return consecutiveEmpty >= UNAVAILABLE_AFTER;
}
