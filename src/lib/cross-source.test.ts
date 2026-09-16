import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import {
  corroborate,
  corroborationLine,
  MATCH_WINDOW_MS,
  MAX_MATCH_KM,
  withCorroboration,
} from "./cross-source";

const NOW = Date.parse("2026-09-16T21:07:58Z");
const KYIV = { lat: 50.45, lon: 30.52 };

function threat(p: Partial<Threat> = {}): Threat {
  return {
    id: "t1",
    name: "Ціль",
    lat: KYIV.lat,
    lon: KYIV.lon,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    lastSeen: new Date(NOW - 60_000).toISOString(),
    type: "shahed",
    quality: {
      uncertaintyKm: 4,
      position: "confirmed",
      lifecycle: "confirmed",
      presumptiveCourse: true,
      speedKmh: null,
    },
    ...p,
  };
}

/** Повідомлення за `km` кілометрів на північ від точки. */
const report = (channel: string, km: number, agoMin = 5) => ({
  lat: KYIV.lat + km / 111.32,
  lon: KYIV.lon,
  channel,
  at: NOW - agoMin * 60_000,
});

describe("corroborate", () => {
  it("рахує РІЗНІ канали, а не кількість повідомлень", () => {
    // Один канал, що написав пʼять разів, — це один свідок, а не пʼять.
    const found = corroborate(
      [threat()],
      [report("a", 1), report("a", 2), report("a", 3), report("b", 1)],
      NOW,
    );
    expect(found.get("t1")?.channels).toEqual(["a", "b"]);
  });

  it("не бачить того, що поза колом цілі", () => {
    const found = corroborate([threat()], [report("a", MAX_MATCH_KM + 20)], NOW);
    expect(found.has("t1")).toBe(false);
  });

  it("радіус пошуку росте разом із невизначеністю цілі", () => {
    /*
     * Головне рішення модуля. Для позначки з розкидом ±2 км вимагати
     * повідомлення за 25 км — зарахувати чуже; для ±25 км вимагати за 5 —
     * не зарахувати своє.
     */
    const tight = threat({
      quality: {
        uncertaintyKm: 1,
        position: "confirmed",
        lifecycle: "confirmed",
        presumptiveCourse: true,
        speedKmh: null,
      },
    });
    const loose = threat({
      quality: {
        uncertaintyKm: 22,
        position: "approx",
        lifecycle: "tracking",
        presumptiveCourse: true,
        speedKmh: null,
      },
    });
    const at18 = [report("a", 18)];
    expect(corroborate([tight], at18, NOW).has("t1")).toBe(false);
    expect(corroborate([loose], at18, NOW).has("t1")).toBe(true);
  });

  it("радіус має стелю — «поруч» не буває безмежним", () => {
    const huge = threat({
      quality: {
        uncertaintyKm: 200,
        position: "approx",
        lifecycle: "uncertain",
        presumptiveCourse: true,
        speedKmh: null,
      },
    });
    const found = corroborate([huge], [report("a", 1)], NOW);
    expect(found.get("t1")!.withinKm).toBeLessThanOrEqual(MAX_MATCH_KM);
  });

  it("старе повідомлення підтвердженням не вважається", () => {
    const old = report("a", 1, MATCH_WINDOW_MS / 60_000 + 10);
    expect(corroborate([threat()], [old], NOW).has("t1")).toBe(false);
  });

  it("повідомлення з майбутнього не зараховуємо", () => {
    expect(corroborate([threat()], [report("a", 1, -30)], NOW).has("t1")).toBe(false);
  });

  it("ціль без придатних координат пропускаємо, а не падаємо", () => {
    const broken = threat({ lat: Number.NaN });
    expect(corroborate([broken], [report("a", 1)], NOW).size).toBe(0);
  });

  it("порядок каналів сталий — перелік іде в текст", () => {
    const a = corroborate([threat()], [report("b", 1), report("a", 2)], NOW);
    const b = corroborate([threat()], [report("a", 2), report("b", 1)], NOW);
    expect(a.get("t1")?.channels).toEqual(b.get("t1")?.channels);
  });
});

describe("withCorroboration", () => {
  it("домішує канали до sources, не гублячи власного джерела", () => {
    const found = corroborate([threat()], [report("chyste_nebo", 2)], NOW);
    const [enriched] = withCorroboration([threat()], found);
    expect(enriched!.sources).toContain("neptun.in.ua");
    expect(enriched!.sources).toContain("chyste_nebo");
  });

  it("не дублює джерело, яке вже було", () => {
    const found = corroborate([threat()], [report("neptun.in.ua", 2)], NOW);
    const [enriched] = withCorroboration([threat({ sources: ["neptun.in.ua"] })], found);
    expect(enriched!.sources!.filter((s) => s === "neptun.in.ua")).toHaveLength(1);
  });

  it("ціль без підтверджень лишається тією самою", () => {
    const t = threat();
    expect(withCorroboration([t], new Map())[0]).toBe(t);
  });
});

describe("corroborationLine", () => {
  it("мовчить, коли підтверджень немає", () => {
    expect(corroborationLine(undefined)).toBe(null);
    expect(corroborationLine({ channels: [], latestAt: null, withinKm: 10 })).toBe(null);
  });

  it("називає число, радіус і що це саме другий агрегатор", () => {
    const line = corroborationLine({ channels: ["a", "b", "c"], latestAt: NOW, withinKm: 12 });
    expect(line).toContain("3");
    expect(line).toContain("12 км");
    expect(line).toContain("другого агрегатора");
  });
});
