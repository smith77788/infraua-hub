import { describe, expect, it } from "bun:test";

import { OBLASTS } from "./alerts";
import { ALL_PLACES, CITIES, OBLAST_CENTERS } from "./ua-cities";

describe("ua-cities", () => {
  it("центри — по одному на область, і їх стільки ж, скільки унікальних кодів", () => {
    const codes = new Set(Object.values(OBLASTS).map((o) => o.code));
    expect(OBLAST_CENTERS).toHaveLength(codes.size);
  });

  it("усі місця без повторів за назвою", () => {
    const names = ALL_PLACES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("велике місто, що не є центром області, у переліку є", () => {
    expect(ALL_PLACES.some((p) => p.name === "Кременчук")).toBe(true);
    expect(ALL_PLACES.some((p) => p.name === "Нікополь")).toBe(true);
    expect(ALL_PLACES.some((p) => p.name === "Маріуполь")).toBe(true);
  });

  it("усі області представлені (місто-центр або сама область)", () => {
    // Для кожного унікального коду області в переліку є місце в радіусі ~15 км
    // від її центру: або однойменне місто, або сам центр.
    const seen = new Map<string, { lat: number; lon: number }>();
    for (const o of Object.values(OBLASTS)) if (!seen.has(o.code)) seen.set(o.code, o);
    for (const c of seen.values()) {
      const near = ALL_PLACES.some(
        (p) => Math.abs(p.lat - c.lat) < 0.2 && Math.abs(p.lon - c.lon) < 0.3,
      );
      expect(near).toBe(true);
    }
  });

  it("упорядковано українською", () => {
    const sorted = ALL_PLACES.slice().sort((a, b) => a.name.localeCompare(b.name, "uk"));
    expect(ALL_PLACES.map((p) => p.name)).toEqual(sorted.map((p) => p.name));
  });

  it("перелік міст суттєвий — більший за десяток", () => {
    expect(CITIES.length).toBeGreaterThan(40);
  });
});
