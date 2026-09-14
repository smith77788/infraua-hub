import { describe, expect, it } from "bun:test";

import { CITIES, matchPlace } from "./places";

describe("matchPlace", () => {
  it("велике місто, що НЕ обласний центр, знаходиться точно", () => {
    const p = matchPlace("Кременчук");
    expect(p?.kind).toBe("city");
    expect(p?.name).toBe("Кременчук");
    // не центр Полтавщини (49.59, 34.55), а сам Кременчук
    expect(p?.lat).toBeCloseTo(49.07, 1);
  });

  it("точний збіг сильніший за область: «Суми» — місто, не «Сумщина»", () => {
    const p = matchPlace("Суми");
    expect(p?.kind).toBe("city");
    expect(p?.name).toBe("Суми");
  });

  it("префікс дає місто: «нікоп» → Нікополь", () => {
    const p = matchPlace("нікоп");
    expect(p?.name).toBe("Нікополь");
  });

  it("апостроф у будь-якому вигляді не заважає: Слов'янськ", () => {
    const straight = matchPlace("Слов'янськ");
    const curly = matchPlace("Словʼянськ");
    expect(straight?.name).toBe("Слов'янськ");
    expect(curly?.name).toBe("Слов'янськ");
  });

  it("назва області веде до центру як запасний варіант", () => {
    const p = matchPlace("Сумщина");
    expect(p?.kind).toBe("oblast");
  });

  it("невпізнане — null", () => {
    expect(matchPlace("Мордор")).toBeNull();
  });

  it("надто короткий запит — null (щоб «к» не ловило пів країни)", () => {
    expect(matchPlace("к")).toBeNull();
  });

  it("серед кількох префіксів — найкоротша назва", () => {
    // «ка» підходить і Каховці, і Калушу, і Кам'янському — має бути детерміновано
    const p = matchPlace("ка");
    expect(p).not.toBeNull();
    const alsoPrefix = CITIES.filter((c) => c.name.toLowerCase().startsWith("ка"));
    const shortest = alsoPrefix.sort((a, b) => a.name.length - b.name.length)[0];
    expect(p?.name).toBe(shortest!.name);
  });

  it("немає дублів назв у переліку", () => {
    const names = CITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
