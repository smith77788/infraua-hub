import { describe, expect, it } from "bun:test";

import { mapNeptunThreat, type NeptunThreat } from "./neptun-map";
import { driftPosition } from "./threat-drift";

/*
 * Записи — з живого потоку neptun.in.ua (2026-10-20, ~02:00), рівно в тій
 * формі, яку віддає v1-потік і REST. Перший — найчастіший випадок: БпЛА з
 * ПРИПУЩЕНИМ курсом («курсом на Олевськ»), другий — із заміряною швидкістю.
 */
const PRESUMED: NeptunThreat = {
  id: "trk_00283043",
  type: "uav",
  title: "БпЛА",
  region: "Житомирська область",
  locality: "Олевськ",
  lat: 51.32267229631553,
  lon: 28.205612970422237,
  heading: 254.432,
  confidenceLevel: "medium",
  sourceCount: 7,
  updatedAt: "2026-10-20T01:46:40Z",
  confirmedAt: "2026-10-20T01:46:40Z",
  explanationShort: "БпЛА курсом на Олевськ. Підтверджень: 7.",
  status: "active",
  uncertaintyKm: 17.9,
  positionQuality: "approx",
  lifecycle: "uncertain",
  presumptiveCourse: true,
};

const MEASURED: NeptunThreat = {
  id: "trk_00283371",
  type: "uav",
  title: "БпЛА",
  region: "Хмельницька область",
  locality: "Славута",
  lat: 50.27662097017056,
  lon: 26.89985305018929,
  heading: 312,
  sourceCount: 6,
  updatedAt: "2026-10-20T01:58:52Z",
  confirmedAt: "2026-10-20T01:58:52Z",
  status: "active",
  velocity: { bearingDeg: 312, speedKmh: 119.5 },
  uncertaintyKm: 10,
  positionQuality: "confirmed",
  lifecycle: "tracking",
};

const at = (iso: string, plusMin: number) => Date.parse(iso) + plusMin * 60_000;

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(b.lon - a.lon)) * Math.cos(r(b.lat));
  const x =
    Math.cos(r(a.lat)) * Math.sin(r(b.lat)) -
    Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

describe("driftPosition — рух як у Нептуна", () => {
  const presumed = mapNeptunThreat(PRESUMED)!;

  it("припущений курс рухається, але на зниженій швидкості (50 км/год для БпЛА)", () => {
    /*
     * Саме цього бракувало: таких цілей більшість, і доти вони стояли. Шість
     * хвилин на 50 км/год — 5 км, а не 18,5 км на реальних 185: див. таблицю в
     * модулі, чому частка шляху тут точніша і за «стояти», і за «повністю».
     */
    const d = driftPosition(presumed, at(PRESUMED.confirmedAt!, 6));
    expect(d.basis).toBe("presumed");
    expect(d.moving).toBe(true);
    expect(d.km).toBeCloseTo(5, 5);
    expect(km(presumed, d)).toBeCloseTo(5, 1);
    expect(bearing(presumed, d)).toBeCloseTo(254.432, 0);
  });

  it("відлік від часу ПІДТВЕРДЖЕННЯ джерелом, а не від нашого прийому", () => {
    // Через 0 хв після підтвердження — на фіксі, хоч би коли ми запис отримали.
    const d = driftPosition(presumed, at(PRESUMED.confirmedAt!, 0));
    expect(d.km).toBe(0);
    expect([d.lat, d.lon]).toEqual([presumed.lat, presumed.lon]);
  });

  it("після стелі (12 хв) стоїть там, куди дійшла, — не стрибає назад", () => {
    const capped = driftPosition(presumed, at(PRESUMED.confirmedAt!, 12));
    const later = driftPosition(presumed, at(PRESUMED.confirmedAt!, 40));
    expect(later.moving).toBe(false);
    expect(later.km).toBeCloseTo(10, 5);
    expect(later.lat).toBeCloseTo(capped.lat, 9);
    expect(later.lon).toBeCloseTo(capped.lon, 9);
  });

  it("курс, який джерело називає спостереженим, — на швидкості типу (150 км/год)", () => {
    const stated = mapNeptunThreat({ ...PRESUMED, presumptiveCourse: false })!;
    const d = driftPosition(stated, at(PRESUMED.confirmedAt!, 6));
    expect(d.basis).toBe("stated");
    expect(d.km).toBeCloseTo(15, 5);
  });

  it("заміряна джерелом швидкість важить більше за типову", () => {
    const m = mapNeptunThreat(MEASURED)!;
    const d = driftPosition(m, at(MEASURED.confirmedAt!, 10));
    expect(d.basis).toBe("measured");
    expect(d.km).toBeCloseTo((119.5 * 10) / 60, 5);
  });

  it("шлях обмежений стелею відстані типу (крилата — 30 км)", () => {
    const cruise = mapNeptunThreat({
      ...PRESUMED,
      type: "missile",
      title: "Крилата ракета",
      explanationShort: "Крилата ракета курсом на Олевськ.",
    })!;
    const d = driftPosition(cruise, at(PRESUMED.confirmedAt!, 10));
    expect(d.km).toBeCloseTo(30, 5);
    expect(d.moving).toBe(false);
  });

  it("КАБ за названим курсом не рухаємо — як і Нептун", () => {
    const kab = mapNeptunThreat({
      ...PRESUMED,
      type: "kab",
      title: "Керована авіабомба",
      explanationShort: "Керована авіабомба — Мелітополь.",
    })!;
    const d = driftPosition(kab, at(PRESUMED.confirmedAt!, 3));
    expect(d.basis).toBe("none");
    expect(d.km).toBe(0);
  });

  it("без курсу — стоїть на фіксі", () => {
    const noCourse = mapNeptunThreat({ ...PRESUMED, heading: null })!;
    const d = driftPosition(noCourse, at(PRESUMED.confirmedAt!, 6));
    expect(d.basis).toBe("none");
    expect([d.lat, d.lon]).toEqual([noCourse.lat, noCourse.lon]);
  });

  it("зіпсований час чи момент до підтвердження — фікс, а не NaN", () => {
    expect(driftPosition({ ...presumed, since: "", lastSeen: "" }, Date.now()).km).toBe(0);
    expect(driftPosition({ ...presumed, since: "не дата" }, Date.now()).km).toBe(0);
    const before = driftPosition(presumed, at(PRESUMED.confirmedAt!, -5));
    expect(before.km).toBe(0);
    const broken = driftPosition({ ...presumed, heading: Number.NaN }, Date.now());
    expect(Number.isFinite(broken.lat) && Number.isFinite(broken.lon)).toBe(true);
  });
});

describe("реактивні — власна швидкість руху, а не шахедова", () => {
  // Та сама ціль з названим (спостереженим) курсом, лише тип різний.
  const { velocity: _v, ...noVelocity } = MEASURED;
  const base = mapNeptunThreat(noVelocity)!;
  const ten = at(MEASURED.confirmedAt!, 5);

  it("за 5 хв реактивний проходить утричі далі за шахеда", () => {
    const shahed = driftPosition({ ...base, type: "shahed" }, ten);
    const jet = driftPosition({ ...base, type: "reactive" }, ten);
    expect(shahed.km).toBeGreaterThan(0);
    expect(jet.km / shahed.km).toBeGreaterThan(2.5);
    // ~450 км/год за 5 хв ≈ 37 км; шахед — 150 км/год ≈ 12,5 км.
    expect(jet.km).toBeGreaterThan(30);
    expect(jet.km).toBeLessThan(45);
  });

  it("стеля є: реактивний не летить по карті вічно", () => {
    const late = driftPosition({ ...base, type: "reactive" }, at(MEASURED.confirmedAt!, 30));
    expect(late.moving).toBe(false);
    expect(late.km).toBeLessThanOrEqual(60);
  });
});
