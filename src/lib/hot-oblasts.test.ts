import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { hotOblasts } from "./hot-oblasts";

/** Точки в різних областях — координати обласних центрів. */
const AT = {
  Чернігівщина: [51.5, 31.29],
  Одещина: [46.48, 30.73],
  Харківщина: [49.99, 36.23],
  Полтавщина: [49.59, 34.55],
  Сумщина: [50.91, 34.8],
} as const;

function at(place: keyof typeof AT, n: number): Threat[] {
  const [lat, lon] = AT[place];
  return Array.from({ length: n }, (_, i) => ({
    id: `${place}-${i}`,
    name: "Ціль",
    lat,
    lon,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    type: "shahed" as const,
  }));
}

describe("hotOblasts", () => {
  it("порожнє небо — порожній перелік", () => {
    const r = hotOblasts([]);
    expect(r.top).toHaveLength(0);
    expect(r.restOblasts).toBe(0);
  });

  it("усе вміщається — нічого за кадром", () => {
    const r = hotOblasts([...at("Чернігівщина", 6), ...at("Одещина", 2)]);
    expect(r.top).toHaveLength(2);
    expect(r.restOblasts).toBe(0);
    expect(r.restTargets).toBe(0);
  });

  it("сума показаного плюс залишок дорівнює всім цілям", () => {
    // Саме та властивість, через яку числа на екрані мають сходитись із
    // лічильником у шапці.
    const threats = [
      ...at("Чернігівщина", 4),
      ...at("Одещина", 4),
      ...at("Харківщина", 3),
      ...at("Полтавщина", 4),
      ...at("Сумщина", 2),
    ];
    const r = hotOblasts(threats);
    const shown = r.top.reduce((s, [, n]) => s + n, 0);
    expect(shown + r.restTargets).toBe(threats.length);
  });

  it("називає, скільки областей лишилось за кадром", () => {
    const r = hotOblasts([
      ...at("Чернігівщина", 4),
      ...at("Одещина", 4),
      ...at("Харківщина", 3),
      ...at("Полтавщина", 4),
      ...at("Сумщина", 2),
    ]);
    expect(r.top).toHaveLength(3);
    expect(r.restOblasts).toBe(2);
    /*
     * Четвірок тут три — Чернігівщина, Одещина, Полтавщина, — і серед них
     * порядок вирішує алфавіт. Тому за кадром лишаються Харківщина 3 і
     * Сумщина 2, тобто пʼять цілей, а не шість.
     */
    expect(r.top.map(([n]) => n)).toEqual(["Одещина", "Полтавщина", "Чернігівщина"]);
    expect(r.restTargets).toBe(5);
  });

  it("порядок сталий при однакових числах — смуга не смикається між тиками", () => {
    const a = hotOblasts([...at("Одещина", 2), ...at("Харківщина", 2)]);
    const b = hotOblasts([...at("Харківщина", 2), ...at("Одещина", 2)]);
    expect(a.top.map(([n]) => n)).toEqual(b.top.map(([n]) => n));
  });
});
