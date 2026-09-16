/**
 * Нічний індекс «льотної ночі» для каналу.
 *
 * Увечері головне питання підписника — не «що в небі зараз» (там ще тихо), а «чи
 * варто цієї ночі бути напоготові». Відповідь складається з двох речей, які вже
 * є в системі: сприятливість погоди для БпЛА (`drone-weather`) і те, коли
 * історично гарячіше (`threat-rhythm`). Разом це вечірній пост, якого не дає
 * жоден монітор: він про НАСТУПНУ ніч, а не про минулий кадр.
 *
 * Це навмисно стриманий сигнал: він каже про УМОВИ, а не оголошує наліт, і
 * виходить раз на вечір. Панікувати щовечора — теж спосіб навчити не вірити.
 *
 * Чистий рендер: складає готові оцінки, сам нічого не рахує з мережі.
 */

import type { DroneWeatherVerdict } from "./drone-weather";
import type { RhythmSummary } from "./threat-rhythm";

export interface FlightNightInput {
  weather: DroneWeatherVerdict;
  /** Загальнонаціональний ритм (агрегат по країні) — може бути невпевненим. */
  rhythm: RhythmSummary | null;
}

const BAND_EMOJI = { favorable: "🔴", mixed: "🟡", adverse: "🟢" } as const;

/**
 * Чи взагалі є що сказати ввечері.
 *
 * Коли погода відверто нельотна — це теж корисно («можна видихнути»), тож
 * пост виходить завжди, але його ТОН залежить від оцінки. Порожнього поста тут
 * не буває: вечірній індекс на те й вечірній, що приходить щовечора.
 */
export function renderFlightNight(input: FlightNightInput): string {
  const { weather, rhythm } = input;
  const emoji = BAND_EMOJI[weather.band];

  const head =
    weather.band === "favorable"
      ? "🌙 <b>Вечірній індекс: погода на боці дронів</b>"
      : weather.band === "adverse"
        ? "🌙 <b>Вечірній індекс: погода проти дронів</b>"
        : "🌙 <b>Вечірній індекс на ніч</b>";

  const lines = [head, "", `${emoji} <b>Погода:</b> ${weather.label}`];
  // Дві головні причини — щоб оцінка не була голослівною.
  for (const r of weather.reasons.slice(0, 2)) lines.push(`• ${r}`);

  if (rhythm && rhythm.confident && rhythm.peakHours.length) {
    lines.push("", `🕑 <b>Історично гарячіше:</b> ${rhythm.label}`);
    if (rhythm.nightShare >= 0.6) {
      lines.push(`Більшість заходів — уночі (${Math.round(rhythm.nightShare * 100)}%).`);
    }
  }

  const advice =
    weather.band === "favorable"
      ? "Тримайте звук увімкненим і валізу під рукою. Персональний радар підкаже, якщо піде на вас."
      : weather.band === "adverse"
        ? "Умови несприятливі для масованого заходу — але це не гарантія. Радар лишається на чаті."
        : "Стежте за обстановкою; персональний радар попередить адресно.";
  lines.push("", advice);
  lines.push("", `<i>${weather.caveat}</i>`);
  return lines.join("\n");
}
