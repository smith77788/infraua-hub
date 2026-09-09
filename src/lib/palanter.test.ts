import { describe, expect, it } from "bun:test";

import { pushSplit, pushableDependencies } from "./palanter.functions";
import type { CategoryId, Facility, GraphEdge } from "./infra-types";

function facility(id: string, category: CategoryId = "substation"): Facility {
  return { id, name: id, category, lat: 50, lon: 30, source: "OSM" };
}

function observedEdge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    km: 10,
    kind: "supply",
    provenance: { kind: "observed", source: "OpenStreetMap", retrievedAt: "2026-09-09" },
  };
}

function inferredEdge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    km: 10,
    kind: "feed",
    provenance: {
      kind: "inferred",
      method: "найближча підстанція",
      params: { radiusKm: 120 },
      confidence: 0.25,
      caveat: "тест",
    },
  };
}

describe("pushableDependencies", () => {
  it("відкидає ребро, кінця якого немає серед обʼєктів пакета", () => {
    const facilities = [facility("a"), facility("b")];
    const edges = [observedEdge("a", "b"), observedEdge("b", "нема"), observedEdge("нема", "a")];
    const out = pushableDependencies(facilities, edges);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: "a", to: "b" });
  });

  it("переносить походження ребра без змін", () => {
    // Уся суть передачі: платформа має отримати не саме ребро, а ребро разом
    // із тим, звідки воно взялося.
    const facilities = [facility("a"), facility("b")];
    const [dep] = pushableDependencies(facilities, [inferredEdge("a", "b")]);
    expect(dep!.provenance).toEqual({
      kind: "inferred",
      method: "найближча підстанція",
      params: { radiusKm: 120 },
      confidence: 0.25,
      caveat: "тест",
    });
  });

  it("не падає на порожньому наборі", () => {
    expect(pushableDependencies([], [])).toEqual([]);
  });
});

describe("pushSplit", () => {
  it("рахує, скільки з надісланого спирається на факт", () => {
    const facilities = [facility("a"), facility("b"), facility("c")];
    const deps = pushableDependencies(facilities, [
      observedEdge("a", "b"),
      inferredEdge("b", "c"),
      inferredEdge("a", "c"),
    ]);
    expect(pushSplit(deps)).toEqual({ observed: 1, inferred: 2 });
  });

  it("порожній набір — нулі, а не помилка", () => {
    expect(pushSplit([])).toEqual({ observed: 0, inferred: 0 });
  });
});
