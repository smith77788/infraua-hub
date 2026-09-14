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
