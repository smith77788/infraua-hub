import { describe, expect, it } from "bun:test";

import { markerFreshness } from "./marker-freshness";

const NOW = Date.parse("2026-10-28T18:13:13Z");
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

describe("markerFreshness — вік у хвилинах і в кілометрах", () => {
  it("ГОЛОВНЕ: реактивний «Коростишів» (417 с) більше не виглядає свіжим", () => {
    // Дослівний вік із зрізу 28.10 18:13: до ≈ 64 км можливого зсуву.
    expect(markerFreshness(ago(417), "reactive", NOW)).toBe("aging");
  });

  it("свіжий реактивний лишається свіжим", () => {
    // «Пулини» на тому ж зрізі — 131 с.
    expect(markerFreshness(ago(131), "reactive", NOW)).toBe("fresh");
  });

  it("для шахеда пороги ті самі, що й були: 12 і 25 хв", () => {
    expect(markerFreshness(ago(11 * 60), "shahed", NOW)).toBe("fresh");
    expect(markerFreshness(ago(13 * 60), "shahed", NOW)).toBe("aging");
    expect(markerFreshness(ago(26 * 60), "shahed", NOW)).toBe("stale");
  });

  it("реактивний застаріває за ≈ 8,4 хв, а не за 25", () => {
    expect(markerFreshness(ago(8 * 60), "reactive", NOW)).toBe("aging");
    expect(markerFreshness(ago(9 * 60), "reactive", NOW)).toBe("stale");
  });

  it("повільний FPV не стає «свіжішим» за часові пороги", () => {
    expect(markerFreshness(ago(13 * 60), "fpv", NOW)).toBe("aging");
  });

  it("невідомий час — не свіжа", () => {
    expect(markerFreshness(undefined, "reactive", NOW)).toBe("unknown");
  });
});
