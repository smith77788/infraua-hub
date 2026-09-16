import { describe, expect, it } from "bun:test";

import { buildRoute, renderRoute, ROAD_SPEED_KMH, sampleRoute } from "./route";

const KYIV = { lat: 50.45, lon: 30.52, label: "Київ" };
const KHARKIV = { lat: 49.99, lon: 36.23, label: "Харків" };

describe("sampleRoute", () => {
  it("починається у виїзді й закінчується в прибутті", () => {
    const s = sampleRoute(KYIV, KHARKIV);
    expect(s[0]!.fromStartKm).toBe(0);
    expect(s[s.length - 1]!.fromStartKm).toBeGreaterThan(380);
  });

  it("крок приблизно той, що замовлено", () => {
    const s = sampleRoute(KYIV, KHARKIV, 40);
    expect(s.length).toBeGreaterThan(8);
    expect(s.length).toBeLessThan(14);
  });

  it("точка сама в себе не ламає вибірку", () => {
    expect(sampleRoute(KYIV, KYIV).length).toBeGreaterThan(0);
  });
});

describe("buildRoute", () => {
  const lookup = (p: { lat: number; lon: number }) => ({
    oblast: p.lon < 33 ? "Київщина" : "Харківщина",
    threats: p.lon < 33 ? 0 : 3,
    alarm: p.lon >= 33,
  });

  it("сусідні ділянки в одній області зливаються", () => {
    // Маршрут із вісьмома рядками «Полтавщина» — це не звіт, це шум.
    const r = buildRoute(KYIV, KHARKIV, lookup);
    expect(r.legs.map((l) => l.oblast)).toEqual(["Київщина", "Харківщина"]);
  });

  it("час прибуття росте вздовж маршруту", () => {
    const r = buildRoute(KYIV, KHARKIV, lookup);
    expect(r.legs[0]!.etaMin).toBe(0);
    expect(r.legs[1]!.etaMin).toBeGreaterThan(60);
  });

  it("тривога на маршруті збирається окремо", () => {
    expect(buildRoute(KYIV, KHARKIV, lookup).alarmOblasts).toEqual(["Харківщина"]);
  });

  it("загальний час рахується зі швидкості, а не вигадується", () => {
    const r = buildRoute(KYIV, KHARKIV, lookup);
    expect(r.totalMin).toBe(Math.round((r.totalKm / ROAD_SPEED_KMH) * 60));
  });

  it("злиття бере ГІРШИЙ стан ділянки, а не останній", () => {
    // Інакше спокійний хвіст області сховав би тривогу на її початку.
    let n = 0;
    const alternating = () => ({ oblast: "Одна", threats: n++ === 0 ? 5 : 0, alarm: n === 1 });
    const r = buildRoute(KYIV, KHARKIV, alternating);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]!.threats).toBe(5);
  });
});

describe("renderRoute", () => {
  const lookup = (p: { lat: number; lon: number }) => ({
    oblast: p.lon < 33 ? "Київщина" : "Харківщина",
    threats: 0,
    alarm: p.lon >= 33,
  });

  it("кожна ділянка підписана часом, коли ви там будете", () => {
    const text = renderRoute(buildRoute(KYIV, KHARKIV, lookup));
    expect(text).toContain("зараз");
    expect(text).toContain("через");
  });

  it("прямо каже, що це обстановка ЗАРАЗ, а не прогноз", () => {
    // Показувати теперішню тривогу як стан на час прибуття означало б лякати
    // тим, що мине.
    expect(renderRoute(buildRoute(KYIV, KHARKIV, lookup))).toContain("а не прогноз");
  });

  it("називає межу методу: пряма, а не дорога", () => {
    expect(renderRoute(buildRoute(KYIV, KHARKIV, lookup))).toContain("не дорога");
  });

  it("тихий маршрут так і підписаний", () => {
    const quiet = () => ({ oblast: "Волинь", threats: 0, alarm: false });
    expect(renderRoute(buildRoute(KYIV, KHARKIV, quiet))).toContain("тривог на маршруті немає");
  });
});
