import { describe, expect, it } from "bun:test";

import { coverage, mergeTiles, pendingTiles, tileBBox, tileGrid, tileKey } from "./tiles";
import { UA_BBOX } from "./infra-types";

describe("tileGrid", () => {
  it("покриває весь bbox без дірок", () => {
    const grid = tileGrid({ south: 0, west: 0, north: 4, east: 4 }, 2);
    expect(grid).toHaveLength(4);
    expect(grid.map(tileKey).sort()).toEqual(["0:0", "0:2", "2:0", "2:2"]);
  });

  it("дає стабільні ключі між викликами", () => {
    // Якби південно-західний кут не округлявся, ключі попливли б і клієнт
    // качав би те саме під іншими іменами.
    const a = tileGrid({ south: 44.2, west: 22.0, north: 45.0, east: 23.0 }, 2).map(tileKey);
    const b = tileGrid({ south: 44.2, west: 22.0, north: 45.0, east: 23.0 }, 2).map(tileKey);
    expect(a).toEqual(b);
    expect(a[0]).toBe("44:22");
  });

  it("покриває Україну скінченною сіткою", () => {
    const grid = tileGrid(UA_BBOX, 2);
    expect(grid.length).toBeGreaterThan(10);
    expect(grid.length).toBeLessThan(100);
  });

  it("не приймає нульовий чи відʼємний крок", () => {
    expect(() => tileGrid(UA_BBOX, 0)).toThrow();
    expect(() => tileGrid(UA_BBOX, -1)).toThrow();
  });
});

describe("tileBBox", () => {
  it("розгортає тайл у межі запиту", () => {
    expect(tileBBox({ south: 50, west: 30 }, 2)).toEqual({
      south: 50,
      west: 30,
      north: 52,
      east: 32,
    });
  });
});

describe("pendingTiles", () => {
  const grid = tileGrid({ south: 0, west: 0, north: 4, east: 4 }, 2);

  it("пропускає те, що клієнт уже має", () => {
    const next = pendingTiles(grid, ["0:0", "0:2"], 10);
    expect(next.map(tileKey)).toEqual(["2:0", "2:2"]);
  });

  it("віддає не більше ліміту за раз", () => {
    expect(pendingTiles(grid, [], 2)).toHaveLength(2);
  });

  it("порожньо, коли покрито все", () => {
    expect(pendingTiles(grid, grid.map(tileKey), 10)).toEqual([]);
  });
});

describe("mergeTiles", () => {
  it("додає нові тайли", () => {
    const merged = mergeTiles(new Map([["a", 1]]), [{ key: "b", value: 2 }]);
    expect([...merged.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("повертає той самий обʼєкт, коли нічого не змінилося", () => {
    // Інакше кожне опитування створювало б нову Map і тягло за собою
    // перерахунок усього графа на порожньому місці.
    const before = new Map([["a", 1]]);
    expect(mergeTiles(before, [{ key: "a", value: 999 }])).toBe(before);
    expect(mergeTiles(before, [])).toBe(before);
  });

  it("не перезаписує вже наявний тайл", () => {
    const merged = mergeTiles(new Map([["a", 1]]), [
      { key: "a", value: 999 },
      { key: "b", value: 2 },
    ]);
    expect(merged.get("a")).toBe(1);
  });
});

describe("coverage", () => {
  it("рахує частку і завершеність", () => {
    expect(coverage(new Map([["a", 1]]), 4)).toEqual({
      loaded: 1,
      total: 4,
      complete: false,
      share: 0.25,
    });
  });

  it("не перевищує сотні відсотків, якщо тайлів прийшло більше", () => {
    expect(
      coverage(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
        1,
      ).share,
    ).toBe(1);
  });

  it("порожня сітка вважається покритою, а не діленням на нуль", () => {
    expect(coverage(new Map(), 0)).toEqual({ loaded: 0, total: 0, complete: true, share: 1 });
  });
});
