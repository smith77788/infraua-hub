import { describe, expect, it } from "bun:test";

import type { AlertRegion } from "./alerts";
import type { FacilityAnalytics } from "./infra-analytics";
import { regionReadiness, rollupRegions } from "./regions";
import type { CategoryId, Facility } from "./infra-types";

function f(id: string, category: CategoryId): Facility {
  return { id, name: id, category, lat: 50, lon: 30, source: "" };
}
function a(id: string, over: Partial<FacilityAnalytics> = {}): FacilityAnalytics {
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
function region(code: string, name: string, active = false): AlertRegion {
  return { code, name, lat: 50, lon: 30, active };
}

describe("rollupRegions", () => {
  const facilities = [
    f("h1", "hospital"),
    f("h2", "hospital"),
    f("s1", "substation"),
    f("g1", "grain"),
  ];
  const regionOf = new Map([
    ["h1", "UA-32"],
    ["h2", "UA-32"],
    ["s1", "UA-32"],
    ["g1", "UA-12"],
  ]);
  const regions = [region("UA-32", "Київщина"), region("UA-12", "Дніпропетровщина")];

  it("рахує обʼєкти, життєзабезпечення й загрози по областях", () => {
    const rows = rollupRegions({
      facilities,
      analytics: new Map([
        ["h1", a("h1", { atRisk: true, score: 70 })],
        ["h2", a("h2", { score: 40 })],
        ["s1", a("s1", { score: 55 })],
        ["g1", a("g1", { score: 20 })],
      ]),
      regionOf,
      regions,
    });
    const kyiv = rows.find((r) => r.code === "UA-32")!;
    expect(kyiv).toMatchObject({ total: 3, life: 2, atRisk: 1, lifeAtRisk: 1, maxScore: 70 });
  });

  it("ставить область із тривогою першою, скільки б там не було обʼєктів", () => {
    // Тривога над однією лікарнею — інша ситуація, ніж двадцять спокійних
    // обʼєктів, і сортування за кількістю ховало б саме це.
    const rows = rollupRegions({
      facilities,
      analytics: new Map(),
      regionOf,
      regions: [region("UA-32", "Київщина"), region("UA-12", "Дніпропетровщина", true)],
    });
    expect(rows[0]!.code).toBe("UA-12");
  });

  it("життєзабезпечення під загрозою важить більше за будь-яку загрозу", () => {
    const rows = rollupRegions({
      facilities,
      analytics: new Map([
        ["h1", a("h1", { atRisk: true })],
        ["g1", a("g1", { atRisk: true })],
      ]),
      regionOf,
      regions,
    });
    expect(rows[0]!.code).toBe("UA-32");
  });

  it("не показує областей, де немає ні обʼєктів, ні тривоги", () => {
    const rows = rollupRegions({
      facilities: [],
      analytics: new Map(),
      regionOf: new Map(),
      regions,
    });
    expect(rows).toEqual([]);
  });

  it("показує область із тривогою навіть без жодного обʼєкта", () => {
    // Тривога — це факт про область, а не про наш перелік обʼєктів.
    const rows = rollupRegions({
      facilities: [],
      analytics: new Map(),
      regionOf: new Map(),
      regions: [region("UA-65", "Херсонщина", true)],
    });
    expect(rows.map((r) => r.code)).toEqual(["UA-65"]);
  });

  it("ігнорує обʼєкт, привʼязаний до невідомої області", () => {
    const rows = rollupRegions({
      facilities,
      analytics: new Map(),
      regionOf: new Map([["h1", "UA-99"]]),
      regions,
    });
    expect(rows).toEqual([]);
  });
});

describe("regionReadiness", () => {
  it("падає рівно на частку уражених", () => {
    expect(
      regionReadiness({
        code: "x",
        name: "x",
        active: false,
        total: 4,
        atRisk: 1,
        life: 0,
        lifeAtRisk: 0,
        maxScore: 0,
      }),
    ).toBe(75);
  });

  it("порожня область — не ділення на нуль", () => {
    expect(
      regionReadiness({
        code: "x",
        name: "x",
        active: false,
        total: 0,
        atRisk: 0,
        life: 0,
        lifeAtRisk: 0,
        maxScore: 0,
      }),
    ).toBe(100);
  });
});
