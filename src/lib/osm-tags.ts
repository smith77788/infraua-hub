/**
 * Читання числових тегів OSM.
 *
 * Один модуль, бо той самий тег розбирався у трьох місцях по-різному, і одне
 * з них давало іншу відповідь: `infra.functions.ts` брав `split(";")[0]` —
 * тобто **перше** значення, а не найбільше. Підстанція з тегом
 * `voltage=110000;330000` показувалася як 110 кВ, хоча в мережі вона працює як
 * вузол 330 кВ. Такі розбіжності не видно, доки не порівняєш два екрани.
 */

/**
 * Найвища напруга з тега, у вольтах.
 *
 * Тег буває списком через крапку з комою: підстанція обслуговує кілька
 * класів напруги, лінія висить на спільних опорах. Роль обʼєкта в мережі
 * визначає вища напруга, тому беремо максимум, а не перше значення.
 */
export function highestVoltage(tag: string | undefined): number | undefined {
  if (!tag) return undefined;
  let best: number | undefined;
  for (const part of tag.split(";")) {
    const value = Number(part.trim());
    // Порожні й нечислові частини трапляються ("110000;;", "110 kV") —
    // пропускаємо мовчки, бо один битий шматок не робить тег непридатним.
    if (!Number.isFinite(value) || value <= 0) continue;
    if (best === undefined || value > best) best = value;
  }
  return best;
}

/** Клас напруги — те, як мережу описують люди, а не сирі вольти. */
export type VoltageClass = "distribution" | "sub_transmission" | "transmission" | "backbone";

/**
 * Межі взяті з української енергосистеми, а не вигадані: 110 кВ — розподіл,
 * 150–220 кВ — субпередача, 330 кВ — основна передача, 750 кВ — магістральні
 * звʼязки та експорт.
 */
export function voltageClass(volts: number | undefined): VoltageClass | undefined {
  if (volts === undefined) return undefined;
  if (volts >= 750_000) return "backbone";
  if (volts >= 330_000) return "transmission";
  if (volts >= 150_000) return "sub_transmission";
  return "distribution";
}

export const VOLTAGE_CLASS_LABEL: Record<VoltageClass, string> = {
  backbone: "Магістральна (750 кВ+)",
  transmission: "Основна передача (330 кВ+)",
  sub_transmission: "Субпередача (150–220 кВ)",
  distribution: "Розподіл (110 кВ)",
};

/** Підпис напруги для інтерфейсу: у кіловольтах, без хибної точності. */
export function formatVoltage(volts: number | undefined): string {
  if (volts === undefined) return "";
  const kv = volts / 1000;
  return `${kv >= 10 ? Math.round(kv) : Math.round(kv * 10) / 10} кВ`;
}

/**
 * Електрична потужність станції в мегаватах із `plant:output:electricity`.
 *
 * Тег вільної форми: трапляється «1000 MW», «1 GW», «500 kW», «730` MW» і
 * просто число. Розбираємо те, що впізнали, і повертаємо `undefined` для
 * решти — вигадана потужність гірша за відсутню, бо на неї спираються.
 */
export function plantOutputMw(tag: string | undefined): number | undefined {
  if (!tag) return undefined;
  const match = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(gw|mw|kw|w)?\s*$/i.exec(tag);
  if (!match) return undefined;
  const value = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return undefined;

  switch ((match[2] ?? "mw").toLowerCase()) {
    case "gw":
      return value * 1000;
    case "kw":
      return value / 1000;
    case "w":
      return value / 1_000_000;
    default:
      // Без одиниці OSM має на увазі вати, але на практиці в цьому тегу
      // майже завжди пишуть мегавати з одиницею. Голе число трактуємо як
      // мегавати й не намагаємося вгадати більше.
      return value;
  }
}
