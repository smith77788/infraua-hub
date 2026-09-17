import { describe, expect, it } from "bun:test";

import { mapNeptunThreat, readTrail, type NeptunThreat } from "./neptun-map";

/** Мінімально валідна ціль у межах України. */
function base(over: Partial<NeptunThreat> = {}): NeptunThreat {
  return {
    id: "trk_1",
    type: "uav",
    title: "БпЛА",
    locality: "Кегичівка",
    lat: 49.6,
    lon: 36.0,
    status: "active",
    ...over,
  };
}

describe("mapNeptunThreat", () => {
  it("перекладає валідну ціль у нашу модель", () => {
    const t = mapNeptunThreat(base({ heading: 205, confidenceLevel: "medium", sourceCount: 2 }));
    expect(t).not.toBeNull();
    expect(t!.id).toBe("trk_1");
    expect(t!.name).toBe("Кегичівка");
    expect(t!.source).toBe("neptun.in.ua");
    expect(t!.type).toBe("shahed");
    expect(t!.heading).toBe(205);
    expect(t!.confidence).toBe("medium");
    expect(t!.reports).toBe(2);
  });

  it("відкидає NaN-координати (typeof NaN === 'number' не рятує)", () => {
    expect(mapNeptunThreat(base({ lat: NaN }))).toBeNull();
    expect(mapNeptunThreat(base({ lon: NaN }))).toBeNull();
  });

  it("відкидає відсутні координати", () => {
    const noLat: NeptunThreat = { id: "trk_1", type: "uav", title: "БпЛА", lon: 36.0 };
    expect(mapNeptunThreat(noLat)).toBeNull();
  });

  it("відкидає неактивні цілі", () => {
    expect(mapNeptunThreat(base({ status: "expired" }))).toBeNull();
    expect(mapNeptunThreat(base({ status: "lost" }))).toBeNull();
  });

  it("відкидає все поза межами України", () => {
    expect(mapNeptunThreat(base({ lat: 60, lon: 36 }))).toBeNull(); // північніше
    expect(mapNeptunThreat(base({ lat: 49, lon: 10 }))).toBeNull(); // західніше
  });

  it("проносить ознаку моря, регіон і курс null не ставить heading", () => {
    const t = mapNeptunThreat(base({ sea: true, region: "Одеська область", heading: null }));
    expect(t!.sea).toBe(true);
    expect(t!.region).toBe("Одеська область");
    expect("heading" in t!).toBe(false);
  });

  it("падає на district/region/title, коли немає locality", () => {
    const d: NeptunThreat = {
      id: "x",
      type: "uav",
      title: "БпЛА",
      district: "Ізюмський",
      lat: 49.6,
      lon: 36.0,
      status: "active",
    };
    expect(mapNeptunThreat(d)!.name).toBe("Ізюмський");
    const r: NeptunThreat = {
      id: "y",
      type: "uav",
      title: "БпЛА",
      region: "Харківська",
      lat: 49.6,
      lon: 36.0,
      status: "active",
    };
    expect(mapNeptunThreat(r)!.name).toBe("Харківська");
  });
});

describe("readTrail", () => {
  it("бере лише пари скінченних координат із часом і мінімум дві точки", () => {
    const ok = readTrail([
      { lat: 49.1, lon: 36.1, t: "2026-09-17T01:00:00Z" },
      { lat: 49.2, lon: 36.2, t: "2026-09-17T01:01:00Z" },
    ]);
    expect(ok).toHaveLength(2);
  });

  it("одна точка — це не трек", () => {
    expect(readTrail([{ lat: 49.1, lon: 36.1, t: "x" }])).toBeNull();
  });

  it("відкидає биті точки, не ламаючись", () => {
    const r = readTrail([
      { lat: 49.1, lon: 36.1, t: "a" },
      { lat: NaN, lon: 36.2, t: "b" },
      null,
      { lat: 49.3, lon: 36.3, t: "c" },
    ]);
    expect(r).toHaveLength(2);
  });

  it("не масив — null", () => {
    expect(readTrail(undefined)).toBeNull();
    expect(readTrail("nope")).toBeNull();
  });
});
