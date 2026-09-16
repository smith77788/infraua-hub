/**
 * Картка «поділитися обстановкою».
 *
 * Найсильніший канал росту цього продукту — не реклама, а рідні: людина, яка
 * бачить обстановку над своїм містом, хоче ОДНИМ дотиком переслати її мамі в
 * інше місто. Досі переслати можна було лише пост каналу (про всю країну) або
 * власну картку радара — а в ній особисті налаштування й точні координати.
 *
 * Ця картка — навмисно знеособлена: назва місця (яку людина обирає сама), рівень
 * і кілька чисел обстановки, без точних координат, без радіуса, без налаштувань.
 * Її не страшно переслати далі, і вона сама кличе нового користувача — знизу
 * рядок «перевір свою точку».
 *
 * Чистий рендер: складає готові оцінки, мережі не торкається.
 */

import type { DangerIndex, PersonalAssessment } from "./advisory";
import type { DroneWeatherVerdict } from "./drone-weather";

const LEVEL_EMOJI = { calm: "🟢", watch: "🟡", attention: "🟠", shelter: "🔴" } as const;

export interface ShareCardInput {
  /** Людська назва місця — місто чи область, яку показуємо. Не координати. */
  placeLabel: string;
  assessment: PersonalAssessment;
  danger: DangerIndex;
  /** Необовʼязково: погодне вікно на ніч. */
  weather?: DroneWeatherVerdict | undefined;
  /** Посилання «перевір свою точку» — бот або сайт. Без нього рядок опускаємо. */
  botLink?: string | undefined;
}

/** Стисла, знеособлена картка обстановки для пересилання. */
export function renderShareCard(input: ShareCardInput): string {
  const { placeLabel, assessment, danger, weather, botLink } = input;
  const emoji = LEVEL_EMOJI[danger.level];

  const lines = [`${emoji} <b>Обстановка · ${placeLabel}</b>`, danger.verdict, ""];

  if (assessment.inboundCount > 0) {
    const eta = assessment.minutesToNearest;
    lines.push(
      `✈️ На точку йде: <b>${assessment.inboundCount}</b>` +
        (eta != null ? ` · найближча ~${eta} хв` : ""),
    );
  } else if (assessment.sky.targets > 0) {
    lines.push(
      `У радіусі ${assessment.sky.radiusKm} км: <b>${assessment.sky.targets}</b>` +
        (assessment.sky.nearestKm != null ? ` · найближча ${assessment.sky.nearestKm} км` : "") +
        " · нічого не йде прямо на точку",
    );
  } else {
    lines.push("Активних цілей у радіусі немає.");
  }

  if (weather && weather.band === "favorable") {
    lines.push(`🌙 Погода на ніч: ${weather.label}`);
  }

  lines.push("", `<i>Оцінка за OSINT, не радар. ${assessment.sky.caveat}</i>`);
  if (botLink) {
    lines.push("", `➡️ Перевір свою точку: ${botLink}`);
  }
  return lines.join("\n");
}
