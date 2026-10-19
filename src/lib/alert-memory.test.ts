import { describe, expect, it } from "bun:test";

import { ALERT_MEMORY_MAX_AGE_MS, packAlertMemory, unpackAlertMemory } from "./alert-memory";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const packed = (at: number) =>
  packAlertMemory(
    ["Сумська область"],
    new Map([["сумська", "red"]]),
    new Map([["Сумська область", at - 600_000]]),
    at,
  );

describe("памʼять обходу тривог", () => {
  it("свіжа памʼять відновлюється повністю", () => {
    const r = unpackAlertMemory(packed(NOW - 60_000), NOW)!;
    expect(r.alerts).toEqual(["Сумська область"]);
    expect(r.levels.get("сумська")).toBe("red");
    expect(r.starts.get("Сумська область")).toBeGreaterThan(0);
  });

  it("стара памʼять відкидається — краще мовчазний старт", () => {
    /*
     * За годину тривоги починались і закінчувались. Порівняння з давнім
     * зрізом видало б пачку «оголошено тривогу» про події, яких уже немає.
     */
    expect(unpackAlertMemory(packed(NOW - ALERT_MEMORY_MAX_AGE_MS - 1000), NOW)).toBeNull();
  });

  it("порожня памʼять — це null, а не порожній стан", () => {
    /*
     * Порожнє «що було» перетворює КОЖНУ активну тривогу на щойно оголошену —
     * тобто редеплой став би хибною сиреною для всіх.
     */
    expect(unpackAlertMemory(null, NOW)).toBeNull();
    expect(unpackAlertMemory("", NOW)).toBeNull();
  });

  it("бите значення не валить обхід", () => {
    expect(unpackAlertMemory("{не json", NOW)).toBeNull();
    expect(unpackAlertMemory('{"alerts":"не масив","at":1}', NOW)).toBeNull();
  });

  it("запис із майбутнього не приймається", () => {
    // Збитий годинник інакше дав би «свіжу» памʼять назавжди.
    expect(unpackAlertMemory(packed(NOW + 10 * 60_000), NOW)).toBeNull();
  });

  it("незнайомий рівень відкидається, решта лишається", () => {
    const raw = JSON.stringify({
      alerts: ["X"],
      levels: { a: "orange", b: "red" },
      starts: {},
      at: NOW,
    });
    const r = unpackAlertMemory(raw, NOW)!;
    expect(r.levels.has("a")).toBe(false);
    expect(r.levels.get("b")).toBe("red");
  });
});
