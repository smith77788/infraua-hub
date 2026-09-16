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

describe("фікс несе час СПОСТЕРЕЖЕННЯ, а не час опитування", () => {
  const NOW = 1_700_000_000_000;

  it("бере observedAt, коли він є", () => {
    const h = updateHistory(
      new Map(),
      [{ id: "a", lat: 50, lon: 30, observedAt: NOW - 300_000 }],
      NOW,
    );
    expect(h.get("a")?.[0]?.ts).toBe(NOW - 300_000);
  });

  it("час із майбутнього відкидає — він дав би відʼємний інтервал", () => {
    const h = updateHistory(
      new Map(),
      [{ id: "a", lat: 50, lon: 30, observedAt: NOW + 60_000 }],
      NOW,
    );
    expect(h.get("a")?.[0]?.ts).toBe(NOW);
  });

  it("різний застій між опитуваннями більше не вигадує швидкості", () => {
    /*
     * Саме той випадок, через який у треках зʼявлялись дрони на тисячу
     * кілометрів за годину. Дві позиції за 50 км одна від одної; опитування
     * розділяють 60 секунд, але спостереження — 20 хвилин. За часом опитування
     * вийшло б 3000 км/год, за часом спостереження — 150.
     */
    let h = updateHistory(
      new Map(),
      [{ id: "a", lat: 50, lon: 30, observedAt: NOW - 1_260_000 }],
      NOW - 60_000,
    );
    h = updateHistory(h, [{ id: "a", lat: 50.45, lon: 30, observedAt: NOW - 60_000 }], NOW);
    const pts = h.get("a")!;
    expect(pts).toHaveLength(2);
    const hours = (pts[1]!.ts - pts[0]!.ts) / 3_600_000;
    const kmh = 50 / hours;
    expect(kmh).toBeLessThan(400);
    expect(kmh).toBeGreaterThan(100);
  });
});

describe("трек джерела сіє історію", () => {
  const NOW = 1_700_000_000_000;

  it("точки з треку стають фіксами одразу, без чекання другого опитування", () => {
    // Доти рух ставав «спостереженим» лише після двох власних опитувань, хоч
    // джерело віддавало готові спостереження з мітками часу разом із ціллю.
    const h = updateHistory(
      new Map(),
      [
        {
          id: "a",
          lat: 51.82,
          lon: 31.946,
          observedAt: NOW - 600_000,
          trail: [
            { lat: 51.36, lon: 32.05, t: new Date(NOW - 1_800_000).toISOString() },
            { lat: 51.82, lon: 31.946, t: new Date(NOW - 600_000).toISOString() },
          ],
        },
      ],
      NOW,
    );
    expect(h.get("a")?.length).toBe(2);
  });

  it("точки впорядковані за часом — від цього залежить кожна оцінка швидкості", () => {
    const h = updateHistory(
      new Map(),
      [
        {
          id: "a",
          lat: 51,
          lon: 31,
          observedAt: NOW - 100_000,
          trail: [
            { lat: 52, lon: 32, t: new Date(NOW - 200_000).toISOString() },
            { lat: 53, lon: 33, t: new Date(NOW - 900_000).toISOString() },
          ],
        },
      ],
      NOW,
    );
    const ts = h.get("a")!.map((p) => p.ts);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("сміття в мітці часу не стає фіксом", () => {
    const h = updateHistory(
      new Map(),
      [{ id: "a", lat: 51, lon: 31, trail: [{ lat: 52, lon: 32, t: "не дата" }] }],
      NOW,
    );
    expect(h.get("a")?.length).toBe(1);
  });

  it("точку з майбутнього не беремо", () => {
    const h = updateHistory(
      new Map(),
      [
        {
          id: "a",
          lat: 51,
          lon: 31,
          trail: [{ lat: 52, lon: 32, t: new Date(NOW + 600_000).toISOString() }],
        },
      ],
      NOW,
    );
    expect(h.get("a")?.length).toBe(1);
  });

  it("той самий момент не дублюється між опитуваннями", () => {
    const point = { lat: 51.82, lon: 31.946, t: new Date(NOW - 600_000).toISOString() };
    let h = updateHistory(
      new Map(),
      [{ id: "a", lat: 51.82, lon: 31.946, observedAt: NOW - 600_000, trail: [point] }],
      NOW - 60_000,
    );
    h = updateHistory(
      h,
      [{ id: "a", lat: 51.82, lon: 31.946, observedAt: NOW - 600_000, trail: [point] }],
      NOW,
    );
    expect(h.get("a")?.length).toBe(1);
  });
});
