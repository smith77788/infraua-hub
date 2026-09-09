import { describe, expect, it } from "bun:test";

import { buildRows, sortRows, type EntityRow } from "./entity-table";
import type { FacilityAnalytics } from "./infra-analytics";
import type { CategoryId, Facility } from "./infra-types";

function facility(id: string, name: string, category: CategoryId, operator?: string): Facility {
  return { id, name, category, lat: 50, lon: 30, source: "OSM", ...(operator ? { operator } : {}) };
}

function analytics(id: string, over: Partial<FacilityAnalytics> = {}): FacilityAnalytics {
  return {
    id,
    dependents: 0,
    atRisk: false,
    underAlarm: false,
    regionCode: null,
    score: 0,
    band: "low",
    signals: [],
    ...over,
  };
}

describe("buildRows", () => {
  it("зводить обʼєкт із його оцінкою в один рядок", () => {
    const rows = buildRows(
      [facility("a", "ПС Північна", "substation", "Укренерго")],
      new Map([["a", analytics("a", { score: 72, band: "severe", dependents: 5 })]]),
    );
    expect(rows[0]).toMatchObject({
      name: "ПС Північна",
      operator: "Укренерго",
      score: 72,
      band: "severe",
      dependents: 5,
      tierLabel: "Енергетика",
    });
  });

  it("обʼєкт без аналітики не вигадує собі оцінку", () => {
    const rows = buildRows([facility("a", "Х", "hospital")], new Map());
    expect(rows[0]).toMatchObject({ score: 0, band: "low", dependents: 0, operator: "" });
  });
});

describe("sortRows", () => {
  const rows: EntityRow[] = buildRows(
    [
      facility("a", "ялина", "hospital"),
      facility("b", "їжак", "substation", "Б"),
      facility("c", "абрикос", "power_plant", "А"),
    ],
    new Map([
      ["a", analytics("a", { score: 10, dependents: 3 })],
      ["b", analytics("b", { score: 90, dependents: 1, underAlarm: true })],
      ["c", analytics("c", { score: 50, dependents: 7, atRisk: true })],
    ]),
  );

  it("сортує за оцінкою в обидва боки", () => {
    expect(sortRows(rows, "score", "desc").map((r) => r.score)).toEqual([90, 50, 10]);
    expect(sortRows(rows, "score", "asc").map((r) => r.score)).toEqual([10, 50, 90]);
  });

  it("впорядковує назви за українською абеткою, а не за кодами символів", () => {
    // Перевірено: рядкова «і» — U+0456, а «я» — U+044F, тож порівняння кодами
    // дає «абрикос, ялина, їжак». За абеткою «ї» стоїть до «я», і саме це
    // читає людина у списку.
    expect(sortRows(rows, "name", "asc").map((r) => r.name)).toEqual(["абрикос", "їжак", "ялина"]);
  });

  it("тримає обʼєкти без оператора в кінці, куди не сортуй", () => {
    // «Немає даних» — не значення, воно не має конкурувати за перше місце.
    expect(sortRows(rows, "operator", "asc").at(-1)!.operator).toBe("");
    expect(sortRows(rows, "operator", "desc").at(-1)!.operator).toBe("");
  });

  it("вважає тривогу серйознішою за подію поруч", () => {
    const byState = sortRows(rows, "state", "desc");
    expect(byState[0]!.underAlarm).toBe(true);
    expect(byState[1]!.atRisk).toBe(true);
  });

  it("не стрибає на однакових значеннях", () => {
    const same = buildRows(
      [facility("x", "Бета", "hospital"), facility("y", "Альфа", "hospital")],
      new Map([
        ["x", analytics("x", { score: 5 })],
        ["y", analytics("y", { score: 5 })],
      ]),
    );
    expect(sortRows(same, "score", "desc").map((r) => r.name)).toEqual(["Альфа", "Бета"]);
    expect(sortRows(same, "score", "asc").map((r) => r.name)).toEqual(["Альфа", "Бета"]);
  });

  it("не змінює вхідний масив", () => {
    const before = rows.map((r) => r.id);
    sortRows(rows, "score", "desc");
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("не падає на порожньому наборі", () => {
    expect(sortRows([], "score", "desc")).toEqual([]);
  });
});
