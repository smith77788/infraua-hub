import { TIER_LABEL, type FacilityAnalytics } from "./infra-analytics";
import { CATEGORIES, type Facility } from "./infra-types";
import { formatVoltage } from "./osm-tags";
import type { CriticalityBand } from "./infra-criticality";

/**
 * Табличний зріз обʼєктів.
 *
 * Карта відповідає на питання «де», граф — «через що», а таблиця — «які саме
 * і в якому порядку». Без неї впорядкувати обʼєкти за чимось, крім
 * заздалегідь зашитого рейтингу, було неможливо: аналітик міг дивитися лише
 * на той зріз, який ми йому вибрали.
 */

export type SortKey =
  "name" | "category" | "operator" | "score" | "dependents" | "state" | "voltage";
export type SortDirection = "asc" | "desc";

export interface EntityRow {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  categoryColor: string;
  tierLabel: string;
  operator: string;
  score: number;
  band: CriticalityBand;
  dependents: number;
  atRisk: boolean;
  underAlarm: boolean;
  /** Напруга у вольтах — для сортування. */
  voltage: number | null;
  /** Готовий підпис — щоб вигляд не переказував модель по-своєму. */
  voltageLabel: string;
  source: string;
}

export function buildRows(
  facilities: Facility[],
  analytics: Map<string, FacilityAnalytics>,
): EntityRow[] {
  return facilities.map((f) => {
    const a = analytics.get(f.id);
    const meta = CATEGORIES[f.category];
    return {
      id: f.id,
      name: f.name,
      category: f.category,
      categoryLabel: meta.label,
      categoryColor: meta.color,
      tierLabel: TIER_LABEL[meta.tier],
      operator: f.operator ?? "",
      score: a?.score ?? 0,
      band: a?.band ?? "low",
      dependents: a?.dependents ?? 0,
      atRisk: a?.atRisk ?? false,
      underAlarm: a?.underAlarm ?? false,
      voltage: f.voltage ?? null,
      voltageLabel: formatVoltage(f.voltage),
      source: f.source,
    };
  });
}

/**
 * Вага стану для сортування: тривога серйозніша за подію поруч, бо загроза
 * триває, а не сталася.
 */
function stateWeight(row: EntityRow): number {
  return (row.underAlarm ? 2 : 0) + (row.atRisk ? 1 : 0);
}

/**
 * Сортує рядки. Ключ `name` порівнюється з урахуванням української абетки —
 * інакше «Ї» опинялося б після «Я», бо порядок кодів не збігається з абеткою.
 */
export function sortRows(rows: EntityRow[], key: SortKey, direction: SortDirection): EntityRow[] {
  const sign = direction === "asc" ? 1 : -1;
  const collator = new Intl.Collator("uk", { numeric: true, sensitivity: "base" });

  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "name":
        cmp = collator.compare(a.name, b.name);
        break;
      case "category":
        cmp = collator.compare(a.categoryLabel, b.categoryLabel);
        break;
      case "operator":
        // Порожній оператор завжди в кінці, у який бік не сортуй: «немає
        // даних» — це не значення, яке має конкурувати за перше місце.
        if (!a.operator && !b.operator) cmp = 0;
        else if (!a.operator) return 1;
        else if (!b.operator) return -1;
        else cmp = collator.compare(a.operator, b.operator);
        break;
      case "score":
        cmp = a.score - b.score;
        break;
      case "dependents":
        cmp = a.dependents - b.dependents;
        break;
      case "voltage":
        // Невідома напруга завжди в кінці: «немає даних» — не нульова
        // напруга, і сортувати їх поруч означало б стверджувати протилежне.
        if (a.voltage === null && b.voltage === null) cmp = 0;
        else if (a.voltage === null) return 1;
        else if (b.voltage === null) return -1;
        else cmp = a.voltage - b.voltage;
        break;
      case "state":
        cmp = stateWeight(a) - stateWeight(b);
        break;
    }
    // Стабільний доводчик, щоб рядки з однаковим значенням не стрибали між
    // перерисовками.
    return cmp * sign || collator.compare(a.name, b.name);
  });
}

export const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "score", label: "Індекс", numeric: true },
  { key: "name", label: "Обʼєкт" },
  { key: "category", label: "Категорія" },
  { key: "voltage", label: "Напруга", numeric: true },
  { key: "operator", label: "Оператор" },
  { key: "dependents", label: "Залежних", numeric: true },
  { key: "state", label: "Стан" },
];

/** Скільки рядків малювати: більше просто не вміщується і гальмує. */
export const ROW_LIMIT = 200;
