/**
 * Стан звʼязку з повітряним фідом — рішення, яке бачить людина.
 *
 * Радар, що тихо показує застиглу картину, — небезпечніший за порожній екран:
 * людина вирішить, що чисто, коли фід просто перестав оновлюватись. Тут одна
 * чиста функція вирішує, ЩО сказати про свіжість: живо, із затримкою, застигло
 * чи звʼязку немає — і робить це гучно, коли треба.
 *
 * Суддя застарілості — вік фіду (коли ми востаннє успішно взяли дані), а не
 * лише `navigator.onLine`: браузер може казати «онлайн», поки до джерела вже не
 * доходить. Але явне «офлайн» показуємо одразу, не чекаючи, поки протухне запит.
 */

import { ageFromEpoch } from "./freshness";
import { FRESHNESS_THRESHOLDS } from "./freshness";

export type AirLink = "live" | "delayed" | "frozen" | "offline" | "nodata";

export interface AirConnection {
  link: AirLink;
  /** Чи показувати банер. Для «live» — ні. */
  banner: boolean;
  level: "info" | "warn" | "danger";
  headline: string;
  detail: string;
  /** Вік останніх даних українською, або null коли даних не було. */
  ageLabel: string | null;
}

export interface AirConnectionInput {
  /** `navigator.onLine`: чи бачить браузер мережу. */
  online: boolean;
  /** Коли фід востаннє успішно оновився (epoch ms), або null/0 якщо ніколи. */
  feedUpdatedAt: number | null;
  /** Чи маємо взагалі якусь картину (живу або з кешу). */
  hasData: boolean;
  now?: number;
}

/**
 * Вирішує стан звʼязку. Порядок перевірок — від найгіршого:
 * немає даних → офлайн → застигло → із затримкою → живо.
 */
export function airConnection(input: AirConnectionInput): AirConnection {
  const { online, feedUpdatedAt, hasData } = input;
  const now = input.now ?? Date.now();
  const { aging, stale } = FRESHNESS_THRESHOLDS.air;
  const age = ageFromEpoch(feedUpdatedAt ?? undefined, aging, stale, now);
  const ageLabel = age.minutes === null ? null : age.label;

  if (!hasData) {
    return {
      link: "nodata",
      banner: true,
      level: "danger",
      headline: "Немає даних про повітря",
      detail: online
        ? "Джерело недоступне або ще вантажимо. Щойно дані прийдуть — покажемо."
        : "Немає звʼязку й немає збережених даних. Оновимо, щойно звʼязок відновиться.",
      ageLabel,
    };
  }

  if (!online) {
    return {
      link: "offline",
      banner: true,
      level: "danger",
      headline: "Немає звʼязку",
      detail: ageLabel
        ? `Показано останнє відоме (${ageLabel}). Це НЕ поточна обстановка.`
        : "Показано останнє відоме. Це НЕ поточна обстановка.",
      ageLabel,
    };
  }

  if (age.freshness === "stale") {
    return {
      link: "frozen",
      banner: true,
      level: "danger",
      headline: "Дані застигли",
      detail: `Фід не оновлюється ${ageLabel ?? "давно"}. Обстановка могла змінитись — не покладайтесь на цю картину.`,
      ageLabel,
    };
  }

  if (age.freshness === "aging") {
    return {
      link: "delayed",
      banner: true,
      level: "warn",
      headline: "Оновлення з затримкою",
      detail: `Останнє оновлення ${ageLabel ?? "щойно"}. Стежимо за відновленням.`,
      ageLabel,
    };
  }

  return {
    link: "live",
    banner: false,
    level: "info",
    headline: "Наживо",
    detail: "",
    ageLabel,
  };
}
