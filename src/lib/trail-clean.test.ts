import { describe, expect, it } from "bun:test";

import { cleanTrail, trailHeading } from "./trail-clean";

// Дослівно треки з проду, 29.10.2026 ~18:40 UTC.
const p = (lat: number, lon: number, hm: string) => ({ lat, lon, t: `2026-10-29T${hm}:00Z` });

describe("cleanTrail — трек без тремтіння й стрибків", () => {
  it("Нікополь: 12 точок туди-сюди між двома місцями за 2 км — не рух", () => {
    const zigzag = Array.from({ length: 12 }, (_, i) =>
      i % 2 ? p(47.571, 34.366, "18:38") : p(47.568, 34.391, "18:37"),
    );
    expect(cleanTrail(zigzag, 225).length).toBeLessThanOrEqual(2);
  });

  it("Кам'янське: стрибок 33 км за нуль хвилин відкинуто — курс на захід, як трек", () => {
    const tr = [p(48.465, 35.046, "18:35"), p(48.519, 34.596, "18:35"), p(48.508, 34.612, "18:40")];
    const c = cleanTrail(tr, 900);
    expect(c).toHaveLength(2);
    const h = trailHeading(c)!;
    expect(h).toBeGreaterThan(260);
    expect(h).toBeLessThan(290);
  });

  it("правдоподібний політ лишається цілим", () => {
    const tr = [p(50.0, 30.0, "18:00"), p(50.1, 30.1, "18:05"), p(50.2, 30.2, "18:10")];
    expect(cleanTrail(tr, 280)).toHaveLength(3);
  });

  it("одна точка — курсу нема", () => {
    expect(trailHeading(cleanTrail([p(50, 30, "18:00")], 280))).toBeNull();
  });
});
