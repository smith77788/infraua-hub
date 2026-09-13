import { describe, expect, it } from "bun:test";

import { trackLatLngs, updateHistory, type FixPoint } from "./track-history";

const T0 = 1_700_000_000_000;

describe("updateHistory", () => {
  it("починає трек із першого фіксу", () => {
    const h = updateHistory(new Map(), [{ id: "a", lat: 50, lon: 30 }], T0);
    expect(h.get("a")).toHaveLength(1);
  });

  it("додає точку, коли ціль зрушила", () => {
    let h = updateHistory(new Map(), [{ id: "a", lat: 50, lon: 30 }], T0);
    h = updateHistory(h, [{ id: "a", lat: 50.2, lon: 30.2 }], T0 + 60000);
    expect(h.get("a")).toHaveLength(2);
  });

  it("НЕ пише дубль при мікрозсуві (та сама позиція)", () => {
    let h = updateHistory(new Map(), [{ id: "a", lat: 50, lon: 30 }], T0);
    h = updateHistory(h, [{ id: "a", lat: 50.0001, lon: 30.0001 }], T0 + 60000);
    expect(h.get("a")).toHaveLength(1);
  });

  it("підрізає трек до maxPoints", () => {
    let h = new Map<string, FixPoint[]>();
    for (let i = 0; i < 10; i++) {
      h = updateHistory(h, [{ id: "a", lat: 50 + i * 0.5, lon: 30 }], T0 + i * 60000, {
        maxPoints: 3,
      });
    }
    expect(h.get("a")).toHaveLength(3);
  });

  it("забуває ціль, якої давно немає у видачі", () => {
    let h = updateHistory(new Map(), [{ id: "a", lat: 50, lon: 30 }], T0);
    // наступне опитування без цілі «a», через 2 години
    h = updateHistory(h, [], T0 + 2 * 60 * 60 * 1000, { maxAgeMs: 60 * 60 * 1000 });
    expect(h.has("a")).toBe(false);
  });

  it("зниклу ціль тримає ще трохи (слід не зникає миттєво)", () => {
    let h = updateHistory(new Map(), [{ id: "a", lat: 50, lon: 30 }], T0);
    h = updateHistory(h, [], T0 + 60000);
    expect(h.has("a")).toBe(true);
  });

  it("не змінює передану мапу (чиста)", () => {
    const prev = new Map<string, FixPoint[]>();
    updateHistory(prev, [{ id: "a", lat: 50, lon: 30 }], T0);
    expect(prev.size).toBe(0);
  });
});

describe("trackLatLngs", () => {
  it("перетворює фікси у пари координат", () => {
    expect(
      trackLatLngs([
        { lat: 50, lon: 30, ts: T0 },
        { lat: 51, lon: 31, ts: T0 + 1 },
      ]),
    ).toEqual([
      [50, 30],
      [51, 31],
    ]);
  });

  it("порожньо для відсутнього треку", () => {
    expect(trackLatLngs(undefined)).toEqual([]);
  });
});
