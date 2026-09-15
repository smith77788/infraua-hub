/**
 * Скільки людей ми фізично встигаємо попередити — і з якого числа вже ні.
 *
 * Цей модуль існує, щоб одна незручна властивість системи була ВИДИМОЮ, а не
 * з'ясувалася з мовчання людей під час нальоту.
 *
 * Telegram документує для розсилки ~30 повідомлень на секунду. Це не наша
 * реалізація і не питання оптимізації: швидше можна лише за платні розсилки
 * (1000/с), які вимагають 100 000 Stars на балансі бота й 100 000 активних
 * користувачів на місяць.
 *
 * Звідси випливає межа, якої немає в жодного монітора цієї ніші, але яка є в
 * усіх: **персональне сповіщення не масштабується так, як канал**. Один пост у
 * канал доходить до будь-якої кількості читачів одним запитом. Персональне
 * попередження — по одному на людину, тридцять за секунду.
 *
 * Тому зростання аудиторії не є тут беззастережним благом, і система має
 * казати власникові правду про свою стелю раніше, ніж у неї впреться.
 */

import { SPEED_KMH } from "./threat-eta";
import { TELEGRAM_BROADCAST_PER_SEC, timeToReachMs } from "./delivery";
import { formatDuration } from "./kyiv";

/**
 * Скільки часу має сповіщення, щоб лишатися корисним.
 *
 * Береться з фізики, а не з відчуття: шахед іде 180 км/год (SPEED_KMH, ті самі
 * відкриті орієнтовні значення, що й для ETA), усталений радіус спостереження —
 * 50 км. Отже від появи цілі на межі радіуса до її підходу минає близько
 * шістнадцяти хвилин. Десять із них — це те, що лишається людині на рішення,
 * якщо попередження прийшло не миттєво.
 */
export const USEFUL_WINDOW_MS = 10 * 60 * 1000;

export function usefulWindowExplained(radiusKm = 50): string {
  const minutes = Math.round((radiusKm / SPEED_KMH.shahed) * 60);
  return `шахед долає ${radiusKm} км приблизно за ${minutes} хв`;
}

export interface Capacity {
  /** Скільки людей отримують сповіщення (з точкою й без паузи). */
  audience: number;
  perSec: number;
  /** Скільки встигаємо попередити в межах корисного вікна. */
  reachable: number;
  /** Скільки НЕ встигаємо. */
  unreachable: number;
  /** Скільки часу потрібно, щоб дійти до кожного. */
  fullSweepMs: number;
  /** Чи вистачає стелі на всю аудиторію. */
  sufficient: boolean;
}

export function capacityFor(
  audience: number,
  opts: { perSec?: number; windowMs?: number } = {},
): Capacity {
  const perSec = opts.perSec ?? TELEGRAM_BROADCAST_PER_SEC;
  const windowMs = opts.windowMs ?? USEFUL_WINDOW_MS;
  const reachable = Math.min(audience, Math.floor((windowMs / 1000) * perSec));
  return {
    audience,
    perSec,
    reachable,
    unreachable: Math.max(0, audience - reachable),
    fullSweepMs: timeToReachMs(audience, perSec),
    sufficient: reachable >= audience,
  };
}

/**
 * Стеля словами.
 *
 * Мовчить, поки запасу вистачає: попередження про межу, до якої ще далеко,
 * перетворюється на фон і не спрацює тоді, коли справді знадобиться.
 */
export function renderCapacity(c: Capacity): string[] {
  if (c.audience === 0) return [];
  const lines = [
    `Стеля розсилки: <b>${c.perSec}/с</b> · повний обхід — <b>${formatDuration(c.fullSweepMs)}</b>`,
  ];
  if (c.sufficient) {
    lines.push(
      `<i>Запасу вистачає: усіх ${c.audience} попереджаємо в межах корисного вікна (${usefulWindowExplained()}).</i>`,
    );
    return lines;
  }
  lines.push(
    `⚠️ <b>Аудиторія переросла стелю.</b> За корисні 10 хв встигаємо попередити <b>${c.reachable}</b> із <b>${c.audience}</b>.`,
    `Решта — <b>${c.unreachable}</b> — отримає сповіщення тоді, коли воно вже нічого не змінить.`,
    "",
    "Це межа Telegram, не коду: безкоштовна розсилка — 30/с. Варіанти рівно два —",
    "• платні розсилки в @BotFather (до 1000/с; потрібні 100 000 Stars і 100 000 активних на місяць);",
    "• переносити навантаження в канал: один пост доходить до всіх одним запитом.",
  );
  return lines;
}

/**
 * З якої аудиторії персональні сповіщення перестають устигати.
 *
 * Число, яке варто знати до того, як у нього впертись.
 */
export function audienceCeiling(
  perSec = TELEGRAM_BROADCAST_PER_SEC,
  windowMs = USEFUL_WINDOW_MS,
): number {
  return Math.floor((windowMs / 1000) * perSec);
}
