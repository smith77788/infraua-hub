import { describe, expect, it } from "bun:test";

import { rankContingencies, simulateOutage } from "./contingency";
import type { CategoryId, Facility, GraphEdge } from "./infra-types";

function node(id: string, category: CategoryId = "substation"): Facility {
  return { id, name: id, category, lat: 50, lon: 30, source: "test" };
}

function observed(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    km: 10,
    kind: "supply",
    provenance: { kind: "observed", source: "OpenStreetMap", retrievedAt: "2026-09-09" },
  };
}

function inferred(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    km: 10,
    kind: "supply",
    provenance: {
      kind: "inferred",
      method: "найближча підстанція",
      params: { radiusKm: 120 },
      confidence: 0.25,
      caveat: "тест",
    },
  };
}

describe("simulateOutage", () => {
  it("не рахує втраченим вузол, у якого лишився інший шлях до генерації", () => {
    // Саме та помилка, заради якої писався модуль: підстанція живиться від
    // двох станцій, і відмова однієї її не гасить.
    const facilities = [
      node("plant-a", "power_plant"),
      node("plant-b", "power_plant"),
      node("sub", "substation"),
      node("hospital", "hospital"),
    ];
    const edges = [
      observed("plant-a", "sub"),
      observed("plant-b", "sub"),
      observed("sub", "hospital"),
    ];

    // Попередня реалізація (`downstreamOf`, прибрана) відповідала на це
    // питання транзитивним замиканням і оголошувала знеструмленими і `sub`, і
    // `hospital`.
    const result = simulateOutage(facilities, edges, "plant-a");
    expect(result.lost.size).toBe(0);
    expect(result.suppliedBefore).toBe(4);
  });

  it("гасить усе, що трималося на єдиному шляху", () => {
    const facilities = [
      node("plant", "power_plant"),
      node("sub", "substation"),
      node("hospital", "hospital"),
    ];
    const edges = [observed("plant", "sub"), observed("sub", "hospital")];
    const result = simulateOutage(facilities, edges, "sub");
    expect([...result.lost].sort()).toEqual(["hospital"]);
  });

  it("не рахує втраченим того, хто й до відмови не мав живлення", () => {
    const facilities = [
      node("plant", "power_plant"),
      node("sub", "substation"),
      node("island", "hospital"),
    ];
    const result = simulateOutage(facilities, [observed("plant", "sub")], "plant");
    expect(result.lost.has("island")).toBe(false);
    expect(result.suppliedBefore).toBe(2);
  });

  it("веде живлення в обидва боки по спостереженій лінії", () => {
    // Лінія фізично двостороння: `to → from` теж працює. Тут генерація
    // приходить у `sub` через ребро, записане в інший бік.
    const facilities = [node("plant", "power_plant"), node("sub", "substation")];
    const result = simulateOutage(facilities, [observed("sub", "plant")], "sub");
    expect(result.suppliedBefore).toBe(2);
    expect(result.lost.size).toBe(0);
  });

  it("не робить двостороннім виведене ребро", () => {
    // Здогадка «plant живить sub» не означає, що sub живить plant.
    const facilities = [
      node("plant", "power_plant"),
      node("sub", "substation"),
      node("other", "substation"),
    ];
    const result = simulateOutage(
      facilities,
      [inferred("plant", "sub"), inferred("other", "sub")],
      "plant",
    );
    expect(result.lost.has("sub")).toBe(true);
    expect(result.lost.has("other")).toBe(false);
  });

  it("відділяє наслідок, доведений спостереженнями, від наслідку з припущень", () => {
    const facilities = [
      node("plant", "power_plant"),
      node("sub", "substation"),
      node("real", "hospital"),
      node("guessed", "hospital"),
    ];
    const edges = [observed("plant", "sub"), observed("sub", "real"), inferred("sub", "guessed")];
    const result = simulateOutage(facilities, edges, "sub");
    expect([...result.lost].sort()).toEqual(["guessed", "real"]);
    // `guessed` висить на здогадці — довести його втрату ми не можемо.
    expect([...result.grounded]).toEqual(["real"]);
  });

  it("повідомляє, що джерел генерації в наборі немає", () => {
    const facilities = [node("a"), node("b")];
    const result = simulateOutage(facilities, [observed("a", "b")], "a");
    expect(result.hasSources).toBe(false);
    expect(result.lost.size).toBe(0);
  });

  it("повертає порожній результат на невідомому вузлі", () => {
    expect(simulateOutage([node("a")], [], "нема").lost.size).toBe(0);
  });
});

describe("rankContingencies", () => {
  it("ранжує відмови за втратами життєзабезпечення, потім за загальними", () => {
    const facilities = [
      node("plant", "power_plant"),
      node("hub", "substation"),
      node("side", "substation"),
      node("h1", "hospital"),
      node("h2", "hospital"),
      node("mill", "industry"),
    ];
    const edges = [
      observed("plant", "hub"),
      observed("hub", "h1"),
      observed("hub", "h2"),
      observed("plant", "side"),
      observed("side", "mill"),
    ];

    const ranked = rankContingencies(facilities, edges);

    // Єдина станція гасить усе — вона й є найгіршою одиничною відмовою.
    // Далі вузол, що тримає обидві лікарні, і аж потім гілка з млином.
    expect(ranked.map((r) => r.id)).toEqual(["plant", "hub", "side"]);
    expect(ranked[0]!.lost).toBe(5);
    expect(ranked[1]!.lifeLost).toBe(2);
    expect(ranked[1]!.lost).toBe(2);

    const side = ranked.find((r) => r.id === "side")!;
    expect(side.lost).toBe(1);
    expect(side.lifeLost).toBe(0);
  });

  it("не показує відмов, що нікого не знеструмлюють", () => {
    // Кільце: будь-який один вузол лишає решту зі шляхом до генерації.
    const facilities = [node("plant", "power_plant"), node("a"), node("b"), node("c")];
    const edges = [
      observed("plant", "a"),
      observed("a", "b"),
      observed("b", "c"),
      observed("c", "plant"),
    ];
    for (const entry of rankContingencies(facilities, edges)) {
      expect(entry.lost).toBeGreaterThan(0);
    }
  });

  it("повертає порожній список без джерел генерації", () => {
    expect(rankContingencies([node("a"), node("b")], [observed("a", "b")])).toEqual([]);
  });

  it("не падає на порожньому наборі", () => {
    expect(rankContingencies([], [])).toEqual([]);
  });
});
