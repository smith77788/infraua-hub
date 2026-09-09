import { CATEGORIES, type Facility, type Tier } from "./infra-types";

/**
 * Фокус — звуження набору до підмножини, названої однією умовою.
 *
 * Числа на панелях обстановки досі були лише написом: «під загрозою 14» не
 * давало способу побачити ці чотирнадцять. Аналітик мусив шукати їх очима по
 * карті серед тисяч інших. Фокус робить кожне таке число входом у свій зріз.
 *
 * Фокус завжди видимий і завжди знімається одним рухом: мовчазний фільтр, про
 * який забули, гірший за його відсутність — порожня карта виглядає як
 * відсутність даних, а не як застосована умова.
 */

export type Focus =
  | null
  | { kind: "risk" }
  | { kind: "life-risk" }
  | { kind: "alarm" }
  | { kind: "tier"; tier: Tier }
  | { kind: "operator"; operator: string }
  | { kind: "region"; code: string; name: string };

export interface FocusContext {
  /** Обʼєкти в радіусі активної події. */
  riskIds: ReadonlySet<string>;
  /** Обʼєкти в областях з активною тривогою. */
  alarmIds: ReadonlySet<string>;
  /** Обʼєкт → код області, з `assignRegions`. */
  regionOf?: ReadonlyMap<string, string>;
}

export function applyFocus(facilities: Facility[], focus: Focus, ctx: FocusContext): Facility[] {
  if (!focus) return facilities;
  switch (focus.kind) {
    case "risk":
      return facilities.filter((f) => ctx.riskIds.has(f.id));
    case "life-risk":
      return facilities.filter(
        (f) => ctx.riskIds.has(f.id) && CATEGORIES[f.category].tier === "life",
      );
    case "alarm":
      return facilities.filter((f) => ctx.alarmIds.has(f.id));
    case "tier":
      return facilities.filter((f) => CATEGORIES[f.category].tier === focus.tier);
    case "operator":
      return facilities.filter((f) => f.operator === focus.operator);
    case "region":
      // Без привʼязки нікого не показуємо: порожній результат чесніший за
      // випадковий набір, зібраний за відсутнім критерієм.
      return ctx.regionOf ? facilities.filter((f) => ctx.regionOf!.get(f.id) === focus.code) : [];
  }
}

const TIER_LABEL: Record<Tier, string> = {
  energy: "Енергетика",
  life: "Життєзабезпечення",
  mobility: "Мобільність",
  comms: "Звʼязок",
  gov: "Держуправління",
  industry: "Промисловість",
};

/** Підпис активного фокуса — те, що видно поруч із кнопкою зняття. */
export function focusLabel(focus: Focus): string {
  if (!focus) return "";
  switch (focus.kind) {
    case "risk":
      return "лише обʼєкти під загрозою";
    case "life-risk":
      return "лише життєзабезпечення під загрозою";
    case "alarm":
      return "лише обʼєкти в зоні тривоги";
    case "tier":
      return `лише сектор «${TIER_LABEL[focus.tier]}»`;
    case "operator":
      return `лише обʼєкти оператора «${focus.operator}»`;
    case "region":
      return `лише ${focus.name}`;
  }
}

/** Чи це той самий фокус — щоб повторне натискання його знімало. */
export function sameFocus(a: Focus, b: Focus): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "tier" && b.kind === "tier") return a.tier === b.tier;
  if (a.kind === "operator" && b.kind === "operator") return a.operator === b.operator;
  if (a.kind === "region" && b.kind === "region") return a.code === b.code;
  return true;
}
