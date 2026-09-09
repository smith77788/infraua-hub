import type { AgeInfo } from "./freshness";

/**
 * Стан джерел даних — одна панель замість розсипаних приміток.
 *
 * У консолі сім живих джерел, і досі кожне повідомляло про себе окремим
 * рядком у різних кутах: тут «дані застаріли», там «Overpass не відповідає»,
 * ще десь «набір неповний». Оператор не може за секунду відповісти на просте
 * питання — чи можна зараз вірити тому, що на екрані.
 *
 * Стан виводиться з того, що вже відомо, і не вигадує нічого понад: якщо про
 * джерело нічого не відомо, це `unknown`, а не «все добре».
 */

export type SourceState = "live" | "loading" | "stale" | "degraded" | "down" | "empty";

export interface SourceInput {
  id: string;
  label: string;
  /** Скільки записів зараз показано з цього джерела. */
  count: number;
  age: AgeInfo;
  /** Джерело не відповідає (кілька порожніх відповідей поспіль). */
  down?: boolean;
  /** Показано резервний перелік замість живих даних. */
  degraded?: boolean;
  /** Прогрес довантаження для джерел, що вантажаться по тайлах. */
  coverage?: { loaded: number; total: number };
  /** Набір обрізаний стелею запиту, тобто неповний. */
  truncated?: boolean;
}

export interface SourceStatus {
  id: string;
  label: string;
  state: SourceState;
  /** Один рядок, що пояснює саме цей стан. */
  detail: string;
  count: number;
}

/**
 * Порядок перевірок — це порядок серйозності. Джерело, яке мовчить, важливіше
 * за неповне покриття: друге зростатиме саме, перше — ні.
 */
export function statusOf(input: SourceInput): SourceStatus {
  const base = { id: input.id, label: input.label, count: input.count };

  if (input.down) {
    return { ...base, state: "down", detail: "не відповідає, довантаження призупинено" };
  }
  if (input.degraded) {
    return { ...base, state: "degraded", detail: "показано резервний перелік, не живі дані" };
  }
  if (input.age.freshness === "stale") {
    return { ...base, state: "stale", detail: `застаріло — ${input.age.label}` };
  }
  if (input.coverage && input.coverage.loaded < input.coverage.total) {
    return {
      ...base,
      state: "loading",
      detail: `${input.coverage.loaded} з ${input.coverage.total} ділянок`,
    };
  }
  if (input.truncated) {
    return { ...base, state: "degraded", detail: "набір обрізаний стелею запиту" };
  }
  if (input.count === 0) {
    return { ...base, state: "empty", detail: "порожньо" };
  }
  return { ...base, state: "live", detail: input.age.label };
}

/** Найгірший стан серед джерел — те, що має бачити оператор одразу. */
const SEVERITY: Record<SourceState, number> = {
  down: 5,
  degraded: 4,
  stale: 3,
  empty: 2,
  loading: 1,
  live: 0,
};

export function worstState(statuses: SourceStatus[]): SourceState {
  let worst: SourceState = "live";
  for (const s of statuses) if (SEVERITY[s.state] > SEVERITY[worst]) worst = s.state;
  return worst;
}

export const SOURCE_STATE_LABEL: Record<SourceState, string> = {
  live: "живе",
  loading: "вантажиться",
  stale: "застаріло",
  degraded: "неповне",
  down: "недоступне",
  empty: "порожньо",
};

export const SOURCE_STATE_TONE: Record<SourceState, string> = {
  live: "bg-emerald-400",
  loading: "bg-sky-400",
  stale: "bg-amber-400",
  degraded: "bg-orange-400",
  down: "bg-red-500",
  empty: "bg-slate-500",
};
