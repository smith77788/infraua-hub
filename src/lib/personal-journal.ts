/**
 * «Ваша ніч» — персональний журнал загрози й ранковий підсумок.
 *
 * Канал підбиває добу для країни. Але людині цікава СВОЯ ніч: скільки годин над
 * її точкою було тривожно, як близько підходило найгостріше, скільки окремих
 * заходів вона переспала. Це те, чого не видно вранці, коли все вже минуло, — і
 * саме воно перетворює «ще один канал» на щось особисте: бот, який пам'ятає твою
 * ніч, а не лише показує чужу.
 *
 * Тут — накопичувач (щотику додає прожиті хвилини за рівнем небезпеки, ловить
 * межі окремих заходів, тримає найближче зближення) і ранковий рендер. Дані
 * плоскі й серіалізовні — журнал лягає в запис підписника й переживає редеплой.
 *
 * Чиста логіка: рівень і час приходять ззовні (з `dangerIndex` і годинника),
 * тут лише арифметика й межі.
 */

import type { DangerLevel } from "./advisory";
import { formatDuration } from "./kyiv";

const LEVEL_RANK: Record<DangerLevel, number> = { calm: 0, watch: 1, attention: 2, shelter: 3 };

export interface NightJournal {
  /** Київська доба, яку цей журнал охоплює. */
  date: string;
  /** Хвилини на рівні «напоготові» і вище. */
  minutesUnderThreat: number;
  /** Хвилини на рівні «в укриття». */
  minutesInShelter: number;
  /** Найближче зближення вхідної цілі за добу, км. */
  closestKm: number | null;
  /** Найбільше вхідних цілей одночасно. */
  peakInbound: number;
  /** Скільки окремих заходів (перехід зі спокою в тривогу). */
  episodes: number;
  /** Найвищий рівень за добу. */
  peakLevel: DangerLevel;
  /** Останній бачений рівень — для лову межі заходу (внутрішнє). */
  lastLevel: DangerLevel;
}

export function emptyJournal(date: string): NightJournal {
  return {
    date,
    minutesUnderThreat: 0,
    minutesInShelter: 0,
    closestKm: null,
    peakInbound: 0,
    episodes: 0,
    peakLevel: "calm",
    lastLevel: "calm",
  };
}

export interface JournalTick {
  level: DangerLevel;
  /** Вхідних цілей зараз. */
  inboundCount: number;
  /** Найближче зближення вхідної цілі зараз, км (або `null`). */
  nearestInboundKm: number | null;
  /** Скільки хвилин минуло від попереднього тику (зі стелею — див. виклик). */
  minutesElapsed: number;
  /** Київська доба зараз. */
  date: string;
}

function maxLevel(a: DangerLevel, b: DangerLevel): DangerLevel {
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
}

/**
 * Додає тик у журнал. Зміна доби скидає журнал на нову — попередній має бути
 * вже надісланий уранці (це робить викликач через `takeForDigest`).
 *
 * Хвилини рахуються за РІВНЕМ на початок інтервалу — тим, що людина реально
 * прожила: якщо між тиками було тривожно, ці хвилини тривожні, навіть якщо на
 * наступному тику вже стихло.
 */
export function accrueNight(journal: NightJournal, tick: JournalTick): NightJournal {
  if (tick.date !== journal.date) {
    // Нова доба: рахуємо цей тик уже в свіжий журнал.
    return accrueNight(emptyJournal(tick.date), { ...tick, minutesElapsed: 0 });
  }
  const minutes = Math.max(0, tick.minutesElapsed);
  const underThreat = LEVEL_RANK[tick.level] >= LEVEL_RANK.attention;
  const inShelter = tick.level === "shelter";

  // Новий захід: перехід зі спокою/спостереження в тривогу.
  const startedEpisode =
    LEVEL_RANK[journal.lastLevel] < LEVEL_RANK.attention &&
    LEVEL_RANK[tick.level] >= LEVEL_RANK.attention;

  const closestKm =
    tick.nearestInboundKm != null
      ? journal.closestKm == null
        ? tick.nearestInboundKm
        : Math.min(journal.closestKm, tick.nearestInboundKm)
      : journal.closestKm;

  return {
    ...journal,
    minutesUnderThreat: journal.minutesUnderThreat + (underThreat ? minutes : 0),
    minutesInShelter: journal.minutesInShelter + (inShelter ? minutes : 0),
    closestKm,
    peakInbound: Math.max(journal.peakInbound, tick.inboundCount),
    episodes: journal.episodes + (startedEpisode ? 1 : 0),
    peakLevel: maxLevel(journal.peakLevel, tick.level),
    lastLevel: tick.level,
  };
}

/** Чи є про що звітувати — тиха доба поста не потребує (крім бажаної тиші). */
export function journalHadThreat(j: NightJournal): boolean {
  return j.episodes > 0 || j.minutesUnderThreat > 0 || j.peakInbound > 0;
}

/**
 * Ранковий підсумок особисто для людини.
 *
 * Тиха ніч — теж відповідь, і бажана: коротке «над вами було спокійно» вартує
 * того, щоб його надіслати, бо воно про людину, а не про країну. Але вона
 * приходить лише тим, хто просив ранковий підсумок, — це вирішує викликач.
 */
export function renderNightSummary(j: NightJournal, pointLabel: string): string {
  if (!journalHadThreat(j)) {
    return [
      "🌅 <b>Ваша ніч</b>",
      `Над точкою «${pointLabel}» було спокійно — жодна ціль не йшла на вас.`,
    ].join("\n");
  }

  const lines = ["🌅 <b>Ваша ніч</b>", `Точка: ${pointLabel}`, ""];
  if (j.minutesUnderThreat > 0) {
    lines.push(`⏱ Під загрозою: <b>${formatDuration(j.minutesUnderThreat * 60_000)}</b>`);
  }
  if (j.minutesInShelter > 0) {
    lines.push(`🛡 З них рівень «в укриття»: <b>${formatDuration(j.minutesInShelter * 60_000)}</b>`);
  }
  if (j.episodes > 0) {
    lines.push(`🌊 Окремих заходів: <b>${j.episodes}</b>`);
  }
  if (j.closestKm != null) {
    lines.push(`🎯 Найближче підходило: <b>${j.closestKm} км</b>`);
  }
  if (j.peakInbound > 1) {
    lines.push(`✈️ Найбільше одночасно на вас: <b>${j.peakInbound}</b>`);
  }
  lines.push("", "<i>Це підсумок за оцінкою OSINT над вашою точкою, не радар.</i>");
  return lines.join("\n");
}
