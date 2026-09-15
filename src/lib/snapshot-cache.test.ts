import { describe, expect, it } from "bun:test";

import {
  dropSnapshot,
  memoryStore,
  readSnapshot,
  staleness,
  writeSnapshot,
} from "./snapshot-cache";

const KEY = "test.snap";

describe("write/readSnapshot", () => {
  it("повертає щойно записане", () => {
    const store = memoryStore();
    writeSnapshot(store, KEY, { targets: 5 }, 1000);
    const snap = readSnapshot<{ targets: number }>(store, KEY, 60_000, 2000);
    expect(snap?.data.targets).toBe(5);
    expect(snap?.at).toBe(1000);
  });

  it("порожньо — null, а не виняток", () => {
    expect(readSnapshot(memoryStore(), KEY)).toBeNull();
  });

  it("задавнє понад maxAgeMs не воскрешаємо (краще «звʼязку немає»)", () => {
    const store = memoryStore();
    writeSnapshot(store, KEY, { targets: 5 }, 0);
    // 40 хв по тому, стеля 30 хв
    expect(readSnapshot(store, KEY, 30 * 60_000, 40 * 60_000)).toBeNull();
  });

  it("знімок «з майбутнього» (годинник з'їхав) відкидається", () => {
    const store = memoryStore();
    writeSnapshot(store, KEY, { targets: 1 }, 10 * 60_000);
    // now раніше за at на 5 хв
    expect(readSnapshot(store, KEY, 30 * 60_000, 5 * 60_000)).toBeNull();
  });

  it("побитий JSON — null, не падіння", () => {
    const store = memoryStore();
    store.setItem(KEY, "{не json");
    expect(readSnapshot(store, KEY)).toBeNull();
  });

  it("чужа версія конверта ігнорується", () => {
    const store = memoryStore();
    store.setItem(KEY, JSON.stringify({ v: 99, at: 1000, data: {} }));
    expect(readSnapshot(store, KEY, 60_000, 1000)).toBeNull();
  });

  it("сховище, що кидає на запис, не валить викликача", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {},
    };
    expect(() => writeSnapshot(throwing, KEY, { a: 1 })).not.toThrow();
  });

  it("dropSnapshot прибирає знімок", () => {
    const store = memoryStore();
    writeSnapshot(store, KEY, { a: 1 }, 1000);
    dropSnapshot(store, KEY);
    expect(readSnapshot(store, KEY, 60_000, 1500)).toBeNull();
  });
});

describe("staleness", () => {
  const BASE = 1_700_000_000_000; // реалістичний epoch (не 0 — то «час невідомий»)
  it("свіже — рівень fresh", () => {
    expect(staleness(BASE, BASE + 30_000).level).toBe("fresh");
  });
  it("кілька хвилин — recent", () => {
    expect(staleness(BASE, BASE + 5 * 60_000).level).toBe("recent");
  });
  it("понад десять хвилин — stale", () => {
    const s = staleness(BASE, BASE + 12 * 60_000);
    expect(s.level).toBe("stale");
    expect(s.label).toContain("хв тому");
  });
  it("вік не буває відʼємним", () => {
    expect(staleness(BASE + 500, BASE).ageMs).toBe(0);
  });
});
