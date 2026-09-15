import { describe, expect, it } from "bun:test";

import { ALL_SHELTERS, sheltersInBox } from "./shelter-data";
import { KIND_LABEL, nearestShelters } from "./shelters";

/*
 * Набір їде в репозиторії, а не питається в мережі під час роботи. Причина
 * заміряна: той самий запит по місту віддавав відповідь то за 10 секунд, то за
 * 45, то не віддавав зовсім. Залежність, яка гальмує саме тоді, коли на неї
 * спирається кнопка «куди сховатися», для аварійної функції не годиться.
 *
 * Тому тести тримають не лише поведінку функцій, а й придатність самого
 * набору: порожній або зіпсований файл має падати тут, а не в людини під
 * тривогою.
 */
describe("набір укриттів", () => {
  it("не порожній", () => {
    expect(ALL_SHELTERS.length).toBeGreaterThan(100);
  });

  it("усі точки в межах України", () => {
    for (const s of ALL_SHELTERS) {
      expect(s.lat).toBeGreaterThan(44);
      expect(s.lat).toBeLessThan(53);
      expect(s.lon).toBeGreaterThan(21);
      expect(s.lon).toBeLessThan(41);
    }
  });

  it("кожна точка має вид із відомого переліку й назву", () => {
    for (const s of ALL_SHELTERS) {
      expect(KIND_LABEL[s.kind]).toBeTruthy();
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.id).toContain("/");
    }
  });

  it("ідентифікатори унікальні", () => {
    expect(new Set(ALL_SHELTERS.map((s) => s.id)).size).toBe(ALL_SHELTERS.length);
  });

  it("метро є — це кістяк покриття у великих містах", () => {
    const metro = ALL_SHELTERS.filter((s) => s.kind === "metro" || s.kind === "metro_entrance");
    expect(metro.length).toBeGreaterThan(50);
  });
});

describe("sheltersInBox", () => {
  const kyiv = { south: 50.34, west: 30.3, north: 50.59, east: 30.79 };

  it("центр Києва віддає точки — і миттєво", () => {
    const t0 = performance.now();
    const found = sheltersInBox(kyiv);
    const ms = performance.now() - t0;
    expect(found.length).toBeGreaterThan(20);
    // Саме заради цього набір і лежить локально.
    expect(ms).toBeLessThan(50);
  });

  it("повертає лише те, що всередині прямокутника", () => {
    for (const s of sheltersInBox(kyiv)) {
      expect(s.lat).toBeGreaterThanOrEqual(kyiv.south);
      expect(s.lat).toBeLessThanOrEqual(kyiv.north);
      expect(s.lon).toBeGreaterThanOrEqual(kyiv.west);
      expect(s.lon).toBeLessThanOrEqual(kyiv.east);
    }
  });

  it("порожній прямокутник посеред моря — порожньо, і це не збій", () => {
    expect(sheltersInBox({ south: 44.5, west: 31.0, north: 44.6, east: 31.1 })).toEqual([]);
  });

  it("від Майдану найближче укриття — пішки", () => {
    const near = nearestShelters({ lat: 50.4501, lon: 30.5234 }, sheltersInBox(kyiv), { limit: 3 });
    expect(near.length).toBeGreaterThan(0);
    expect(near[0]!.walkMin).toBeLessThanOrEqual(15);
  });
});
