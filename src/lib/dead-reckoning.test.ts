import { describe, expect, it } from "bun:test";

import {
  advance,
  maxProjectionSpeedKmh,
  PROJECTION_CAP_MS,
  projectedKm,
  projectionSpeedKmh,
  resolveProjectionSpeedKmh,
} from "./dead-reckoning";

describe("projectionSpeedKmh", () => {
  it("повільні дрони протягуємо за нижньою межею швидкості", () => {
    expect(projectionSpeedKmh("shahed")).toBe(185);
    expect(projectionSpeedKmh("recon")).toBe(100);
    expect(projectionSpeedKmh("reactive")).toBe(500);
    expect(projectionSpeedKmh("unknown")).toBe(120);
  });

  it("швидкі цілі НЕ протягуємо (0)", () => {
    expect(projectionSpeedKmh("ballistic")).toBe(0);
    expect(projectionSpeedKmh("cruise")).toBe(0);
    expect(projectionSpeedKmh("missile")).toBe(0);
    expect(projectionSpeedKmh("kab")).toBe(0);
    expect(projectionSpeedKmh("aircraft")).toBe(0);
    expect(projectionSpeedKmh(undefined)).toBe(0);
  });
});

describe("resolveProjectionSpeedKmh", () => {
  it("без заміру — консервативна нижня межа типу", () => {
    expect(resolveProjectionSpeedKmh("shahed", null)).toBe(185);
    expect(resolveProjectionSpeedKmh("shahed", undefined)).toBe(185);
  });

  it("із заміром — бере заміряну (точніше за припущення)", () => {
    expect(resolveProjectionSpeedKmh("shahed", 240)).toBe(240);
  });

  it("замір обрізається стелею типу (викид не жбурляє дрон)", () => {
    expect(resolveProjectionSpeedKmh("shahed", 5000)).toBe(maxProjectionSpeedKmh("shahed"));
    expect(maxProjectionSpeedKmh("shahed")).toBe(600);
  });

  it("швидкі типи не тягнемо навіть із заміряною швидкістю", () => {
    expect(resolveProjectionSpeedKmh("cruise", 800)).toBe(0);
    expect(resolveProjectionSpeedKmh("ballistic", 6000)).toBe(0);
    expect(maxProjectionSpeedKmh("cruise")).toBe(0);
  });
});

describe("projectedKm", () => {
  it("шлях = швидкість × час", () => {
    // 185 км/год за 60 с = ~3.08 км
    expect(projectedKm(185, 60_000)).toBeCloseTo(3.083, 2);
  });

  it("обрізається стелею — далі не тягнемо", () => {
    const atCap = projectedKm(185, PROJECTION_CAP_MS);
    expect(projectedKm(185, PROJECTION_CAP_MS + 60_000)).toBe(atCap);
  });

  it("нульова швидкість або нульовий час — нуль", () => {
    expect(projectedKm(0, 60_000)).toBe(0);
    expect(projectedKm(185, 0)).toBe(0);
  });
});

describe("advance", () => {
  it("на північ (0°) збільшує широту, довготу лишає", () => {
    const p = advance(49, 30, 0, 11.132); // ~0.1° широти
    expect(p.lat).toBeCloseTo(49.1, 2);
    expect(p.lon).toBeCloseTo(30, 3);
  });

  it("на схід (90°) збільшує довготу, широту майже лишає", () => {
    const p = advance(49, 30, 90, 20);
    expect(p.lon).toBeGreaterThan(30);
    expect(p.lat).toBeCloseTo(49, 1);
  });

  it("нульова відстань — та сама точка", () => {
    const p = advance(49, 30, 123, 0);
    expect(p).toEqual({ lat: 49, lon: 30 });
  });

  it("пройдена відстань відповідає заданій", () => {
    const lat = 49,
      lon = 30,
      km = 25;
    const p = advance(lat, lon, 45, km);
    // грубо через гаверсинус
    const R = 6371;
    const dLat = ((p.lat - lat) * Math.PI) / 180;
    const dLon = ((p.lon - lon) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat * Math.PI) / 180) * Math.cos((p.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    const dist = 2 * R * Math.asin(Math.sqrt(a));
    expect(dist).toBeCloseTo(km, 1);
  });
});
