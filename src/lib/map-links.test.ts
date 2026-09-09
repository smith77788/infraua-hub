import { describe, expect, it } from "bun:test";

import { linkStyle, selectVisibleLinks } from "./map-links";
import type { GraphEdge } from "./infra-types";

function edge(id: string, observed: boolean): GraphEdge {
  return {
    from: `${id}-a`,
    to: `${id}-b`,
    km: 1,
    kind: "supply",
    provenance: observed
      ? { kind: "observed", source: "OpenStreetMap", retrievedAt: "2026-09-09" }
      : { kind: "inferred", method: "найближча", params: {}, confidence: 0.3, caveat: "тест" },
  };
}

describe("selectVisibleLinks", () => {
  it("під стелею показує все", () => {
    const edges = [edge("1", true), edge("2", false)];
    const r = selectVisibleLinks(edges, 10);
    expect(r.visible).toEqual(edges);
    expect(r.hidden).toBe(0);
    expect(r.observedVisible).toBe(1);
  });

  it("ховає припущення, а не факти", () => {
    // Раніше бралися просто перші N, тож реальна лінія могла зникнути, а
    // здогадка лишитися — суто через порядок у масиві.
    const edges = [
      edge("guess1", false),
      edge("guess2", false),
      edge("real1", true),
      edge("real2", true),
    ];
    const r = selectVisibleLinks(edges, 2);
    expect(r.visible.map((e) => e.from)).toEqual(["real1-a", "real2-a"]);
    expect(r.hidden).toBe(2);
    expect(r.observedVisible).toBe(2);
  });

  it("добирає припущеннями, коли фактів менше за стелю", () => {
    const edges = [edge("g1", false), edge("r1", true), edge("g2", false)];
    const r = selectVisibleLinks(edges, 2);
    expect(r.visible.map((e) => e.from)).toEqual(["r1-a", "g1-a"]);
    expect(r.hidden).toBe(1);
    expect(r.observedVisible).toBe(1);
  });

  it("рахує приховане точно", () => {
    const edges = Array.from({ length: 100 }, (_, i) => edge(`e${i}`, i % 4 === 0));
    const r = selectVisibleLinks(edges, 30);
    expect(r.visible).toHaveLength(30);
    expect(r.hidden).toBe(70);
    expect(r.observedVisible).toBe(25);
  });

  it("не падає на порожньому наборі", () => {
    expect(selectVisibleLinks([], 10)).toEqual({ visible: [], hidden: 0, observedVisible: 0 });
  });
});

describe("linkStyle", () => {
  it("малює факт суцільним, а припущення пунктиром", () => {
    expect(linkStyle(edge("a", true), { impacted: false }).dashArray).toBeUndefined();
    expect(linkStyle(edge("b", false), { impacted: false }).dashArray).toBeDefined();
  });

  it("робить припущення помітно блідішим за факт", () => {
    const fact = linkStyle(edge("a", true), { impacted: false });
    const guess = linkStyle(edge("b", false), { impacted: false });
    expect(guess.opacity).toBeLessThan(fact.opacity);
    expect(guess.weight).toBeLessThan(fact.weight);
  });

  it("наслідок відмови видно поверх усього", () => {
    const hit = linkStyle(edge("a", false), { impacted: true });
    expect(hit.opacity).toBeGreaterThan(linkStyle(edge("a", true), { impacted: false }).opacity);
  });
});
