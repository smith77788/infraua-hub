/**
 * Рівні тривоги: жовтий і червоний — і район, а не лише область.
 *
 * ## Чого бракувало
 *
 * Наше джерело тривог (`ubilling`) віддає на область рівно одне: `alertnow`,
 * так або ні. Тому карта фарбувала всю область однаково й не могла сказати
 * найважливішого — ЧОГО саме чекати. «Дронова загроза» і «ракетна загроза» —
 * різні дії й різний запас часу, а виглядали однаково.
 *
 * Друге: тривогу дедалі частіше оголошують по РАЙОНАХ, а не на цілу область.
 * Карта, що фарбує область цілком, у такому разі або лякає тих, кого не
 * стосується, або (якщо мовчить) не попереджає тих, кого стосується.
 *
 * ## Що робить цей модуль
 *
 * Розбирає відповідь джерела, яке дає і рівень, і район. Нічого не вигадує:
 * рівень береться як є, а причина — тим самим текстом, яким її оголосили.
 *
 * Два рівні НЕ впорядковані «жовтий = слабша тривога». Червоний означає
 * швидшу загрозу (ракета), жовтий — повільнішу (дрон). Для людини це не
 * «менше/більше», а «скільки маю часу», тож у тексті ми називаємо причину, а
 * не лише колір.
 */

export type AlertLevel = "red" | "yellow";

export interface AlertArea {
  /** Стабільний ключ джерела — для порівняння між оновленнями. */
  key: string;
  /** Назва, як її дало джерело. */
  name: string;
  /** Область, до якої належить район; для області — вона сама. */
  oblast: string;
  level: AlertLevel;
  /** Коли оголошено, ISO. Порожньо — джерело не сказало. */
  since: string;
  /** Причини словами джерела: «Ракетна загроза (червоний рівень)». */
  reasons: string[];
}

export interface AlertLevels {
  /** Тривоги, оголошені на ЦІЛУ область. */
  oblasts: AlertArea[];
  /** Тривоги, оголошені по окремих районах. */
  raions: AlertArea[];
  /** Коли джерело оновило цей зріз, ISO. Порожньо — не сказало. */
  updatedAt: string;
}

export const EMPTY_LEVELS: AlertLevels = { oblasts: [], raions: [], updatedAt: "" };

function readArea(value: unknown): AlertArea | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const level = v["level"];
  // Незнайомий рівень відкидаємо цілком, а не зводимо до червоного: вигаданий
  // рівень гірший за його відсутність — на нього люди діятимуть як на справжній.
  if (level !== "red" && level !== "yellow") return null;
  const name = typeof v["name"] === "string" ? v["name"] : "";
  if (!name) return null;
  const rawReasons = v["reasons"];
  return {
    key: typeof v["key"] === "string" ? v["key"] : name,
    name,
    oblast: typeof v["oblast"] === "string" ? v["oblast"] : name,
    level,
    since: typeof v["since"] === "string" ? v["since"] : "",
    reasons: Array.isArray(rawReasons) ? rawReasons.filter((r) => typeof r === "string") : [],
  };
}

/**
 * Розбір відповіді джерела.
 *
 * `null` — не «тривог немає», а «не змогли прочитати». Різниця тут критична:
 * порожній перелік фарбує карту в спокій, тобто СТВЕРДЖУЄ, що ніде не тривожно.
 * Таке твердження на битій відповіді — найгірше, що може зробити монітор.
 */
export function parseAlertLevels(body: unknown): AlertLevels | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const oblasts = b["oblasts"];
  const raions = b["raions"];
  if (!Array.isArray(oblasts) && !Array.isArray(raions)) return null;
  return {
    oblasts: (Array.isArray(oblasts) ? oblasts : [])
      .map(readArea)
      .filter((a): a is AlertArea => a !== null),
    raions: (Array.isArray(raions) ? raions : [])
      .map(readArea)
      .filter((a): a is AlertArea => a !== null),
    updatedAt: typeof b["updatedAt"] === "string" ? b["updatedAt"] : "",
  };
}

/** Нормалізація назви області: джерела пишуть «Київська обл.» і «Київська область». */
export function oblastKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*(область|обл\.?|region)\s*$/u, "")
    .replace(/^м\.\s*/u, "")
    .trim();
}

/**
 * Найгостріший рівень, оголошений для області.
 *
 * Враховує і тривогу на цілу область, і тривоги в її районах: якщо в одному
 * районі ракетна загроза, область на оглядовій карті має світитись червоним —
 * інакше людина, яка дивиться на країну цілком, цього просто не побачить.
 *
 * `null` — у цій області не оголошено нічого.
 */
export function levelForOblast(levels: AlertLevels, oblastName: string): AlertLevel | null {
  const key = oblastKey(oblastName);
  let found: AlertLevel | null = null;
  for (const a of [...levels.oblasts, ...levels.raions]) {
    if (oblastKey(a.oblast) !== key && oblastKey(a.name) !== key) continue;
    if (a.level === "red") return "red";
    found = "yellow";
  }
  return found;
}

/** Райони області, де щось оголошено — щоб назвати їх поіменно. */
export function raionsOf(levels: AlertLevels, oblastName: string): AlertArea[] {
  const key = oblastKey(oblastName);
  return levels.raions.filter((a) => oblastKey(a.oblast) === key);
}

/**
 * Причини словами джерела, без повторів.
 *
 * Саме причина, а не колір, каже людині, що робити: «дронова загроза» лишає
 * час дійти до укриття, «ракетна» — ні.
 */
export function reasonsFor(levels: AlertLevels, oblastName: string): string[] {
  const key = oblastKey(oblastName);
  const out = new Set<string>();
  for (const a of [...levels.oblasts, ...levels.raions]) {
    if (oblastKey(a.oblast) !== key && oblastKey(a.name) !== key) continue;
    for (const r of a.reasons) out.add(r);
  }
  return [...out];
}

/** Кольори рівнів. Тут одне місце правди — карта й легенда беруть звідси. */
export const LEVEL_COLOR: Record<AlertLevel, string> = {
  red: "#ef4444",
  yellow: "#eab308",
};

export const LEVEL_LABEL: Record<AlertLevel, string> = {
  red: "червоний рівень",
  yellow: "жовтий рівень",
};
