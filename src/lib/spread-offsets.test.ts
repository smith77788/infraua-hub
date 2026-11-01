import { describe, expect, it } from "bun:test";

import { spreadOffsets } from "./spread-offsets";

describe("spreadOffsets — цілі в одній точці окремими значками", () => {
  it("одиночну ціль не зсуває", () => {
    expect(spreadOffsets([{ id: "a", lat: 50, lon: 30 }]).size).toBe(0);
  });

  it("дві в одній точці — різні зсуви, рівні за довжиною", () => {
    const m = spreadOffsets([
      { id: "fpv", lat: 48.5001, lon: 35.0002 },
      { id: "uav", lat: 48.5003, lon: 35.0001 },
    ]);
    const [a, b] = [m.get("fpv")!, m.get("uav")!];
    expect(a).not.toEqual(b);
    expect(Math.hypot(...a)).toBeCloseTo(Math.hypot(...b), 0);
  });

  it("цілі за кілька км одна від одної не чіпає", () => {
    expect(
      spreadOffsets([
        { id: "a", lat: 50.0, lon: 30.0 },
        { id: "b", lat: 50.05, lon: 30.05 },
      ]).size,
    ).toBe(0);
  });

  it("зсув стабільний між кадрами: не залежить від порядку", () => {
    const pts = [
      { id: "x", lat: 49.2, lon: 28.4 },
      { id: "y", lat: 49.2, lon: 28.4 },
      { id: "z", lat: 49.2, lon: 28.4 },
    ];
    expect(spreadOffsets(pts)).toEqual(spreadOffsets([...pts].reverse()));
  });
});
