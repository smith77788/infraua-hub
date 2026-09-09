import { describe, expect, it } from "bun:test";

import type { FacilityAnalytics } from "./infra-analytics";
import { operatorProfile, rankOperators } from "./operators";
import type { CategoryId, Facility } from "./infra-types";

function f(id: string, category: CategoryId, operator?: string): Facility {
  return {
    id,
    name: id,
    category,
    lat: 50,
    lon: 30,
    source: "",
    ...(operator ? { operator } : {}),
  };
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

const facilities = [
  f("s1", "substation", "Укренерго"),
  f("s2", "substation", "Укренерго"),
  f("h1", "hospital", "Укренерго"),
  f("g1", "grain", "Кернел"),
  f("x1", "industry"),
];
const analytics = new Map<string, FacilityAnalytics>([
  ["s1", a("s1", { score: 88, atRisk: true })],
  ["s2", a("s2", { score: 40 })],
  ["h1", a("h1", { score: 60, underAlarm: true })],
  ["g1", a("g1", { score: 25 })],
  ["x1", a("x1", { score: 95 })],
]);

describe("operatorProfile", () => {
  it("зводить усе, що система знає про організацію", () => {
    const p = operatorProfile("Укренерго", facilities, analytics)!;
    expect(p.total).toBe(3);
    expect(p.atRisk).toBe(1);
    expect(p.underAlarm).toBe(1);
    expect(p.maxScore).toBe(88);
    expect(p.avgScore).toBe(63);
  });

  it("показує, у скількох секторах присутній оператор", () => {
    // Концентрація в одному секторі і присутність у кількох — різні ризики.
    const p = operatorProfile("Укренерго", facilities, analytics)!;
    expect(p.sectors.map((s) => [s.label, s.count])).toEqual([
      ["Енергетика", 2],
      ["Життєзабезпечення", 1],
    ]);
  });

  it("ставить найкритичніші обʼєкти першими", () => {
    const p = operatorProfile("Укренерго", facilities, analytics)!;
    expect(p.facilities.map((r) => r.facility.id)).toEqual(["s1", "h1", "s2"]);
  });

  it("повертає null, а не порожнє досьє", () => {
    // Порожня картка виглядає як відповідь «нічого немає», хоча насправді ми
    // просто не знаємо такої організації.
    expect(operatorProfile("Невідомо", facilities, analytics)).toBeNull();
  });

  it("не падає на обʼєкті без аналітики", () => {
    const p = operatorProfile("Кернел", facilities, new Map())!;
    expect(p.maxScore).toBe(0);
    expect(p.avgScore).toBe(0);
    expect(p.total).toBe(1);
  });
});

describe("rankOperators", () => {
  it("впорядковує за найвищим індексом, а не за кількістю обʼєктів", () => {
    // Три підстанції 750 кВ важливіші за двісті трансформаторних будок, і
    // рахунок обʼєктів цього не показує.
    const many = [
      ...Array.from({ length: 20 }, (_, i) => f(`m${i}`, "industry", "Багато")),
      f("big", "power_plant", "Мало"),
    ];
    const stats = new Map<string, FacilityAnalytics>([
      ...many.slice(0, 20).map((x) => [x.id, a(x.id, { score: 10 })] as const),
      ["big", a("big", { score: 90 })],
    ]);
    expect(rankOperators(many, stats).map((p) => p.operator)).toEqual(["Мало", "Багато"]);
  });

  it("пропускає обʼєкти без оператора", () => {
    const ranked = rankOperators(facilities, analytics);
    expect(ranked.map((p) => p.operator).sort()).toEqual(["Кернел", "Укренерго"]);
  });

  it("тримає ліміт", () => {
    const lots = Array.from({ length: 30 }, (_, i) => f(`f${i}`, "industry", `Оп${i}`));
    expect(rankOperators(lots, new Map(), 5)).toHaveLength(5);
  });

  it("не падає на порожньому наборі", () => {
    expect(rankOperators([], new Map())).toEqual([]);
  });
});
