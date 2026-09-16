/**
 * Проактивна тривога рідним у колі.
 *
 * Досі коло було одностороннім: людина сама тиснула «я в порядку», і рідні
 * бачили відмітку. Але найгостріший момент — інший: коли над кимось із кола
 * СПРАВДІ небезпечно, а він мовчить, бо якраз біжить в укриття або спить. Саме
 * тоді рідні мали б дізнатися перші, а не останні.
 *
 * Тут — рішення «сповістити коло про небезпеку над учасником» із двома
 * запобіжниками. Приватність: НІКОЛИ не передаємо координат — лише смугу
 * відстані («ближче 10 км»), бо пост можна переслати, і точне місце рідного
 * обернулося б проти нього. Антиспам: сповіщаємо на вході в рівень «в укриття»
 * і не частіше за кулдаун, інакше нічний наліт завалив би рідних чергою
 * однакових попереджень.
 *
 * І дзеркальне питання — після відбою: хто з кола був під загрозою й досі не
 * відмітився «я в порядку». Це і є привід перевірити рідних, а не вгадувати.
 *
 * Чиста логіка: рішення й текст окремо від мережі та сховища.
 */

import type { DangerLevel } from "./advisory";
import { escapeHtml } from "./telegram";

/** Мінімальна пауза між тривогами кола про того самого учасника. */
export const CIRCLE_ALERT_COOLDOWN_MS = 25 * 60 * 1000;

/**
 * Смуга відстані замість точного числа — і тим паче замість координат.
 *
 * Рідним важливо «наскільки серйозно», а не «де саме»: перше заспокоює або
 * піднімає, друге лише видає місце людини тому, хто перешле пост далі.
 */
export function distanceBand(km: number | null): string {
  if (km == null) return "поруч";
  if (km < 10) return "ближче 10 км";
  if (km < 30) return "10–30 км";
  if (km < 60) return "30–60 км";
  return "далі 60 км";
}

export interface CircleAlertParams {
  /** Імʼя учасника в колі (як він сам підписався). */
  name: string | null | undefined;
  circleName: string;
  level: DangerLevel;
  /** Відстань до найближчої вхідної цілі, км (для смуги, не для показу точно). */
  nearestKm: number | null;
  /** Коли востаннє сповіщали коло про цього учасника (стійка позначка). */
  lastCircleAlertAt: number | null | undefined;
  now: number;
  cooldownMs?: number;
}

export interface CircleAlertDecision {
  send: boolean;
  reason: string;
  /** Готовий текст для решти кола (порожній, коли `send: false`). */
  text: string;
}

/**
 * Чи слати рідним тривогу про небезпеку над учасником.
 *
 * Поріг — рівень «в укриття»: нижчі рівні («стежте») підняли б рідних дарма.
 * Кулдаун рахується від останнього такого сповіщення саме про цю людину.
 */
export function decideCircleAlert(p: CircleAlertParams): CircleAlertDecision {
  const cooldown = p.cooldownMs ?? CIRCLE_ALERT_COOLDOWN_MS;
  if (p.level !== "shelter") {
    return { send: false, reason: "рівень нижчий за «в укриття»", text: "" };
  }
  if (p.lastCircleAlertAt != null && p.now - p.lastCircleAlertAt < cooldown) {
    return { send: false, reason: "нещодавно вже сповіщали коло", text: "" };
  }
  const name = escapeHtml((p.name ?? "Хтось").slice(0, 40));
  const circle = escapeHtml(p.circleName);
  const band = distanceBand(p.nearestKm);
  const text = [
    `⚠️ <b>${name}</b> — у зоні тривоги`,
    `Коло «${circle}» · загроза ${band}`,
    "",
    "Це автоматичне попередження за обстановкою над точкою учасника. " +
      "Спробуйте звʼязатися; коли він у безпеці — відмітить сам.",
  ].join("\n");
  return { send: true, reason: "рівень «в укриття», кулдаун вичерпано", text };
}

export interface CircleMemberState {
  chatId: number;
  name: string | null | undefined;
  /** Коли востаннє над учасником був рівень «в укриття». */
  lastDangerAt: number | null | undefined;
  /** Коли учасник востаннє відмітився «я в порядку». */
  okAt: number | null | undefined;
}

export interface PendingCheckin {
  chatId: number;
  name: string;
  dangerAgoMs: number;
}

/**
 * Хто був під загрозою й досі не відмітився.
 *
 * `sinceMs` — вікно після небезпеки, у якому мовчання ще тривожне (за
 * замовчуванням година): пізніше людина, найпевніше, просто зайнята, і сіяти
 * паніку через півдоби було б гірше за мовчання. Той, хто відмітився ПІСЛЯ
 * своєї небезпеки, зі списку зникає.
 */
export function pendingCheckins(
  members: readonly CircleMemberState[],
  now: number,
  sinceMs = 60 * 60 * 1000,
): PendingCheckin[] {
  const out: PendingCheckin[] = [];
  for (const m of members) {
    if (m.lastDangerAt == null) continue;
    const age = now - m.lastDangerAt;
    if (age < 0 || age > sinceMs) continue;
    const confirmed = m.okAt != null && m.okAt >= m.lastDangerAt;
    if (confirmed) continue;
    out.push({ chatId: m.chatId, name: (m.name ?? "Учасник").slice(0, 40), dangerAgoMs: age });
  }
  // Найдавніша тривога без відмітки — найтривожніша, її показуємо першою.
  return out.sort((a, b) => b.dangerAgoMs - a.dangerAgoMs);
}
