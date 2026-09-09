import { describe, expect, it } from "bun:test";

import type { AlertRegion } from "./alerts";
import { analyzeNetwork, operatorRollup } from "./infra-analytics";
import type { CategoryId, Facility, GraphEdge, InfraEvent } from "./infra-types";

function facility(
  id: string,
  category: CategoryId,
  lat = 50,
  lon = 30,
  operator?: string,
): Facility {
  return { id, name: id, category, lat, lon, source: "test", ...(operator ? { operator } : {}) };
}

function edge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    km: 5,
    kind: "supply",
    provenance: { kind: "observed", source: "test", retrievedAt: "2026-09-09" },
  };
}

const NO_EVENTS: InfraEvent[] = [];
const NO_REGIONS: AlertRegion[] = [];

describe("analyzeNetwork — оцінка як сума названих сигналів", () => {
  const facilities = [
    facility("plant", "power_plant"),
    facility("sub-a", "substation", 50.1),
    facility("sub-b", "substation", 50.2),
    facility("hospital", "hospital", 50.3),
    facility("mill", "industry", 50.4),
  ];
  const edges = [
    edge("plant", "sub-a"),
    edge("sub-a", "sub-b"),
    edge("sub-b", "hospital"),
    edge("sub-b", "mill"),
  ];

  it("нічого не додає до оцінки поза сигналами", () => {
    // Це і є весь сенс заміни: число, яке не дорівнює сумі своїх пояснень,
    // неможливо оскаржити поіменно.
    const { perFacility } = analyzeNetwork(facilities, edges, NO_EVENTS, NO_REGIONS);
    for (const a of perFacility.values()) {
      const sum = a.signals.reduce((n, s) => n + s.contribution, 0);
      expect(a.score).toBe(Math.min(100, sum));
    }
  });

  it("кожен сигнал має причину і доказ", () => {
    const { perFacility } = analyzeNetwork(facilities, edges, NO_EVENTS, NO_REGIONS);
    for (const a of perFacility.values()) {
      for (const s of a.signals) {
        expect(s.reason.length).toBeGreaterThan(0);
        expect(s.evidence.length).toBeGreaterThan(0);
      }
    }
  });

  it("тримає лікарню високо саме через сектор життєзабезпечення", () => {
    // Регресія, якої ми ледь не припустилися: стара оцінка давала вагу тиру
    // прихованим коефіцієнтом, і без явного сигналу лікарня без залежних
    // впала б у нуль.
    const { perFacility } = analyzeNetwork(facilities, edges, NO_EVENTS, NO_REGIONS);
    const hospital = perFacility.get("hospital")!;
    const sector = hospital.signals.find((s) => s.id === "sector")!;
    expect(sector.label).toBe("Життєзабезпечення");
    expect(hospital.score).toBeGreaterThan(perFacility.get("mill")!.score);
  });

  it("знаходить структурного посередника, якого не бачить підрахунок споживачів", () => {
    // sub-a має одного прямого сусіда нижче за течією, але через нього
    // проходить увесь шлях від станції до решти мережі.
    const { perFacility } = analyzeNetwork(facilities, edges, NO_EVENTS, NO_REGIONS);
    const subA = perFacility.get("sub-a")!;
    expect(subA.signals.some((s) => s.id === "brokerage" || s.id === "bridge")).toBe(true);
  });

  it("піднімає оцінку об'єкта поруч із подією і називає це сигналом", () => {
    const event: InfraEvent = {
      id: "e1",
      title: "Пожежа",
      kind: "fire",
      lat: 50.3,
      lon: 30,
      time: new Date().toISOString(),
      source: "test",
    };
    const base = analyzeNetwork(facilities, edges, NO_EVENTS, NO_REGIONS);
    const hit = analyzeNetwork(facilities, edges, [event], NO_REGIONS);
    expect(hit.perFacility.get("hospital")!.score).toBeGreaterThan(
      base.perFacility.get("hospital")!.score,
    );
    expect(hit.perFacility.get("hospital")!.signals.some((s) => s.id === "event_nearby")).toBe(
      true,
    );
  });

  it("позначає тривогу в області і враховує її в оцінці", () => {
    const region: AlertRegion = {
      code: "UA-32",
      name: "Київщина",
      lat: 50.45,
      lon: 30.52,
      active: true,
    };
    const { perFacility } = analyzeNetwork(facilities, edges, NO_EVENTS, [region]);
    const a = perFacility.get("plant")!;
    expect(a.underAlarm).toBe(true);
    expect(a.signals.some((s) => s.id === "alarm")).toBe(true);
  });

  it("сортує рейтинг за спаданням оцінки", () => {
    const { ranked } = analyzeNetwork(facilities, edges, NO_EVENTS, NO_REGIONS);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.a.score).toBeGreaterThanOrEqual(ranked[i]!.a.score);
    }
  });

  it("не падає на порожньому наборі", () => {
    const r = analyzeNetwork([], [], NO_EVENTS, NO_REGIONS);
    expect(r.ranked).toEqual([]);
    expect(r.sectors).toEqual([]);
  });
});

describe("готовність секторів", () => {
  it("падає рівно на частку уражених обʼєктів сектора", () => {
    const facilities = [
      facility("h1", "hospital", 50.0),
      facility("h2", "hospital", 51.0),
      facility("h3", "hospital", 52.0),
      facility("h4", "hospital", 53.0),
    ];
    const event: InfraEvent = {
      id: "e",
      title: "Пожежа",
      kind: "fire",
      lat: 50.0,
      lon: 30,
      time: new Date().toISOString(),
      source: "test",
    };
    const { sectors } = analyzeNetwork(facilities, [], [event], NO_REGIONS);
    const life = sectors.find((s) => s.tier === "life")!;
    expect(life.total).toBe(4);
    expect(life.atRisk).toBe(1);
    expect(life.readiness).toBe(75);
  });
});

describe("operatorRollup", () => {
  it("зводить обʼєкти за оператором і рахує середню оцінку", () => {
    const facilities = [
      facility("a", "substation", 50.0, 30, "Укренерго"),
      facility("b", "substation", 50.5, 30, "Укренерго"),
      facility("c", "hospital", 51.0, 30),
    ];
    const analysis = analyzeNetwork(facilities, [], NO_EVENTS, NO_REGIONS);
    const rows = operatorRollup(facilities, analysis);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operator).toBe("Укренерго");
    expect(rows[0]!.total).toBe(2);
    const expected = Math.round(
      (analysis.perFacility.get("a")!.score + analysis.perFacility.get("b")!.score) / 2,
    );
    expect(rows[0]!.avgScore).toBe(expected);
  });
});
