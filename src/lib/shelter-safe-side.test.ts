import { describe, expect, it } from "bun:test";

import { rankBySafeSide } from "./shelter-safe-side";

const point = { lat: 50, lon: 30 };
// Укриття приблизно на північ, схід, південь від точки.
const north = { id: "N", lat: 50.1, lon: 30 };
const east = { id: "E", lat: 50, lon: 30.14 };
const south = { id: "S", lat: 49.9, lon: 30 };

describe("rankBySafeSide", () => {
  it("без напрямку загрози — порядок і бік не чіпаються", () => {
    const marks = rankBySafeSide(point, [north, east, south], null);
    expect(marks.map((m) => m.item.id)).toEqual(["N", "E", "S"]);
    expect(marks[0]!.note).toBeNull();
  });

  it("загроза з півдня — південне укриття позначене як «в бік загрози»", () => {
    // Загроза підходить з півдня: азимут із точки на ціль ≈ 180°.
    const marks = rankBySafeSide(point, [north, east, south], 180);
    const s = marks.find((m) => m.item.id === "S")!;
    const n = marks.find((m) => m.item.id === "N")!;
    expect(s.side).toBe("toward");
    expect(n.side).toBe("away");
  });

  it("безпечний бік підіймається вище за небезпечний", () => {
    const marks = rankBySafeSide(point, [south, north], 180);
    // Північне (геть від загрози) має стати першим, попри вхідний порядок.
    expect(marks[0]!.item.id).toBe("N");
    expect(marks[0]!.side).toBe("away");
    expect(marks[0]!.note).toContain("протилежний");
  });

  it("близьке прийнятне не програє далекому ідеальному (стабільність за порядком)", () => {
    // Обидва — фланг: тайбрейкер лишає вхідний порядок (за відстанню).
    const marks = rankBySafeSide(point, [east, { id: "E2", lat: 50.001, lon: 30.14 }], 180);
    expect(marks[0]!.item.id).toBe("E");
  });
});
