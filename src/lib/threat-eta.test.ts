import { describe, expect, it } from "bun:test";

import { angularDiff, bearingDeg, citiesOnCourse, projectThreats } from "./threat-eta";
import type { CategoryId, Facility } from "./infra-types";
import type { Threat } from "./air";

function fac(id: string, category: CategoryId, lat: number, lon: number): Facility {
  return { id, name: id, category, lat, lon, source: "test" };
}

function threat(id: string, lat: number, lon: number, extra: Partial<Threat> = {}): Threat {
  return { id, name: id, lat, lon, source: "@ch", count: 1, since: "", expires: "", ...extra };
}

describe("bearingDeg", () => {
  it("вказує на північ для точки прямо вище", () => {
    expect(bearingDeg({ lat: 50, lon: 30 }, { lat: 51, lon: 30 })).toBeCloseTo(0, 0);
  });
  it("вказує на схід для точки праворуч", () => {
    expect(bearingDeg({ lat: 50, lon: 30 }, { lat: 50, lon: 31 })).toBeCloseTo(90, 0);
  });
});

describe("angularDiff", () => {
  it("бере найкоротший бік кола", () => {
    expect(angularDiff(350, 10)).toBe(20);
    expect(angularDiff(10, 350)).toBe(20);
    expect(angularDiff(0, 180)).toBe(180);
  });
});

describe("projectThreats", () => {
  const kyiv = fac("f1", "power_plant", 50.45, 30.52);

  it("ловить ціль, що йде курсом на критичний обʼєкт", () => {
    // Ціль на південь від обʼєкта, курс 0° (на північ) — прямо на нього.
    const t = threat("t1", 49.55, 30.52, { heading: 0, type: "cruise" });
    const out = projectThreats([t], [kyiv]);
    expect(out).toHaveLength(1);
    expect(out[0]!.facility.id).toBe("f1");
    expect(out[0]!.etaMin).toBeGreaterThan(0);
    expect(out[0]!.offAxisDeg).toBeLessThanOrEqual(22);
  });

  it("відкидає ціль, що летить геть від обʼєкта", () => {
    const t = threat("t2", 49.55, 30.52, { heading: 180, type: "cruise" }); // на південь
    expect(projectThreats([t], [kyiv])).toHaveLength(0);
  });

  it("ігнорує цілі без курсу", () => {
    const t = threat("t3", 49.55, 30.52, { type: "cruise" });
    expect(projectThreats([t], [kyiv])).toHaveLength(0);
  });

  it("швидший тип дає менший ETA на тій самій дистанції", () => {
    const slow = threat("s", 49.55, 30.52, { heading: 0, type: "shahed" });
    const fast = threat("f", 49.55, 30.52, { heading: 0, type: "ballistic" });
    const es = projectThreats([slow], [kyiv])[0]!.etaMin;
    const ef = projectThreats([fast], [kyiv])[0]!.etaMin;
    expect(ef).toBeLessThan(es);
  });

  it("залишає один обʼєкт лише з найтерміновішою ціллю", () => {
    const near = threat("near", 50.2, 30.52, { heading: 0, type: "cruise" });
    const far = threat("far", 49.4, 30.52, { heading: 0, type: "cruise" });
    const out = projectThreats([far, near], [kyiv]);
    expect(out).toHaveLength(1);
    expect(out[0]!.threat.id).toBe("near");
  });

  it("за замовчуванням бере лише критичні категорії", () => {
    const shop = fac("shop", "other" as CategoryId, 50.45, 30.52);
    const t = threat("t", 49.55, 30.52, { heading: 0, type: "cruise" });
    expect(projectThreats([t], [shop])).toHaveLength(0);
    expect(projectThreats([t], [shop], { criticalOnly: false })).toHaveLength(1);
  });
});

describe("citiesOnCourse", () => {
  const cities = [
    { name: "Полтава", lat: 49.59, lon: 34.55 },
    { name: "Суми", lat: 50.9, lon: 34.8 },
    { name: "Львів", lat: 49.84, lon: 24.03 },
  ];

  it("місто по курсу — з ETA за швидкістю типу", () => {
    // Шахед південніше Полтави, курс 0° (на північ) → Полтава на курсі.
    const r = citiesOnCourse(threat("s", 49.0, 34.55, { type: "shahed", heading: 0 }), cities);
    expect(r[0]?.name).toBe("Полтава");
    expect(r[0]?.etaMin).toBeGreaterThan(0);
  });

  it("без курсу — порожньо (не вигадуємо напрямок)", () => {
    expect(citiesOnCourse(threat("s", 49.0, 34.55, { type: "shahed" }), cities)).toHaveLength(0);
  });

  it("місто збоку від курсу не потрапляє", () => {
    // Курс на північ, а Львів далеко на захід — не на курсі.
    const r = citiesOnCourse(threat("s", 49.0, 34.55, { type: "shahed", heading: 0 }), cities);
    expect(r.some((c) => c.name === "Львів")).toBe(false);
  });
});

/*
 * Те, що джерело каже про власну точність, має доходити до часу підльоту.
 * Заміри з живої відповіді neptun: радіус невизначеності 4..45 км, а для
 * цілі із заміряною швидкістю 99 км/год таблиця типових дала б 180 — тобто
 * майже вдвічі оптимістичніший час.
 */
describe("projectThreats — невизначеність доходить до часу", () => {
  const target: Facility[] = [
    { id: "pp", name: "ТЕЦ", category: "power_plant", lat: 51, lon: 30, source: "test" },
  ];

  it("вилка часу ширшає разом із заявленою невизначеністю", () => {
    const tight = projectThreats(
      [
        threat("a", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 4,
            position: "confirmed",
            lifecycle: "tracking",
            presumptiveCourse: false,
            speedKmh: null,
          },
        }),
      ],
      target,
    );
    const loose = projectThreats(
      [
        threat("b", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 45,
            position: "approx",
            lifecycle: "uncertain",
            presumptiveCourse: false,
            speedKmh: null,
          },
        }),
      ],
      target,
    );
    expect(tight).toHaveLength(1);
    expect(loose).toHaveLength(1);
    const width = (p: (typeof tight)[number]) => p.etaRangeMin[1] - p.etaRangeMin[0];
    expect(width(loose[0]!)).toBeGreaterThan(width(tight[0]!));
    // Середня оцінка при цьому та сама — ширшає саме невпевненість.
    expect(loose[0]!.etaMin).toBe(tight[0]!.etaMin);
  });

  it("середня оцінка лежить усередині вилки", () => {
    const [p] = projectThreats(
      [
        threat("a", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 10,
            position: "approx",
            lifecycle: "tracking",
            presumptiveCourse: false,
            speedKmh: null,
          },
        }),
      ],
      target,
    );
    expect(p!.etaRangeMin[0]).toBeLessThanOrEqual(p!.etaMin);
    expect(p!.etaRangeMin[1]).toBeGreaterThanOrEqual(p!.etaMin);
  });

  it("заміряна швидкість б'є таблицю типових", () => {
    const measured = projectThreats(
      [
        threat("a", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 4,
            position: "confirmed",
            lifecycle: "tracking",
            presumptiveCourse: false,
            speedKmh: 99.4,
          },
        }),
      ],
      target,
    );
    const typical = projectThreats([threat("b", 50, 30, { heading: 0, type: "shahed" })], target);
    expect(measured[0]!.speedMeasured).toBe(true);
    expect(typical[0]!.speedMeasured).toBe(false);
    // 99 км/год проти типових 180 — ціль іде повільніше, отже часу більше.
    expect(measured[0]!.etaMin).toBeGreaterThan(typical[0]!.etaMin);
  });

  it("припущений курс позначається, а не видається за спостережений", () => {
    const [p] = projectThreats(
      [
        threat("a", 50, 30, {
          heading: 0,
          type: "shahed",
          quality: {
            uncertaintyKm: 25,
            position: "approx",
            lifecycle: "uncertain",
            presumptiveCourse: true,
            speedKmh: null,
          },
        }),
      ],
      target,
    );
    expect(p!.courseObserved).toBe(false);
  });

  it("без заяв джерела вилка все одно не нульова", () => {
    const [p] = projectThreats([threat("a", 50, 30, { heading: 0, type: "shahed" })], target);
    expect(p!.courseObserved).toBe(true);
    expect(p!.etaRangeMin[1]).toBeGreaterThan(p!.etaRangeMin[0]);
  });
});
