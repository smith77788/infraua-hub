import { describe, expect, it } from "bun:test";

import {
  estimateVelocity,
  forecastCone,
  projectForward,
  reachedPlaces,
  swarmVector,
  trailToFixes,
  type TrackFix,
} from "./trajectory";

/** Синтетичний прямий трек: із (lat0,lon0) курсом bearing зі швидкістю км/год. */
function straightTrack(
  lat0: number,
  lon0: number,
  bearingDeg: number,
  speedKmh: number,
  fixes: number,
  stepSec: number,
): TrackFix[] {
  const th = (bearingDeg * Math.PI) / 180;
  const out: TrackFix[] = [];
  for (let i = 0; i < fixes; i++) {
    const km = (speedKmh * (i * stepSec)) / 3600;
    const dLat = (km * Math.cos(th)) / 111.32;
    const dLon = (km * Math.sin(th)) / (111.32 * Math.cos((lat0 * Math.PI) / 180));
    out.push({ lat: lat0 + dLat, lon: lon0 + dLon, t: i * stepSec * 1000 });
  }
  return out;
}

describe("estimateVelocity — відновлення відомого руху", () => {
  it("прямий трек на схід повертає курс ~90° і задану швидкість", () => {
    const v = estimateVelocity(straightTrack(50, 30, 90, 180, 6, 60));
    expect(v).not.toBeNull();
    expect(v!.bearingDeg).toBeGreaterThanOrEqual(88);
    expect(v!.bearingDeg).toBeLessThanOrEqual(92);
    expect(v!.speedKmh).toBeGreaterThanOrEqual(170);
    expect(v!.speedKmh).toBeLessThanOrEqual(190);
    expect(v!.confidence).toBeGreaterThan(0.9); // ідеальна пряма
  });

  it("курс на північ ≈ 0°, на південь ≈ 180°, на захід ≈ 270°", () => {
    expect(estimateVelocity(straightTrack(49, 33, 0, 150, 5, 60))!.bearingDeg % 360).toBeLessThan(
      3,
    );
    expect(estimateVelocity(straightTrack(49, 33, 180, 150, 5, 60))!.bearingDeg).toBeGreaterThan(
      177,
    );
    expect(estimateVelocity(straightTrack(49, 33, 270, 150, 5, 60))!.bearingDeg).toBeGreaterThan(
      267,
    );
  });

  it("замало точок або замало часу — null (не вгадуємо)", () => {
    expect(estimateVelocity([{ lat: 50, lon: 30, t: 0 }])).toBeNull();
    // два фікси за 10 с — нижче порогу тривалості
    expect(
      estimateVelocity([
        { lat: 50, lon: 30, t: 0 },
        { lat: 50.02, lon: 30, t: 10_000 },
      ]),
    ).toBeNull();
  });

  it("нерухома ціль — null (швидкість нижча за поріг)", () => {
    const still: TrackFix[] = [0, 60, 120, 180].map((s) => ({ lat: 50, lon: 30, t: s * 1000 }));
    expect(estimateVelocity(still)).toBeNull();
  });

  it("неправдоподібний стрибок (телепорт між містами) — null, це шум позначок", () => {
    const jump: TrackFix[] = [
      { lat: 50, lon: 30, t: 0 },
      { lat: 50, lon: 30, t: 60_000 },
      { lat: 48, lon: 37, t: 120_000 }, // ~600 км за хвилину
    ];
    expect(estimateVelocity(jump)).toBeNull();
  });

  it("хаотичний рух знижує впевненість проти прямої", () => {
    const straight = estimateVelocity(straightTrack(50, 30, 45, 200, 8, 40))!;
    const noisy = estimateVelocity([
      { lat: 50.0, lon: 30.0, t: 0 },
      { lat: 50.1, lon: 30.3, t: 40_000 },
      { lat: 50.05, lon: 30.1, t: 80_000 },
      { lat: 50.2, lon: 30.5, t: 120_000 },
      { lat: 50.1, lon: 30.2, t: 160_000 },
    ]);
    expect(noisy).not.toBeNull();
    expect(noisy!.confidence).toBeLessThan(straight.confidence);
  });
});

describe("trailToFixes", () => {
  it("парсить ISO-час і сортує за часом", () => {
    const fixes = trailToFixes([
      { lat: 50.2, lon: 30.2, t: "2026-09-15T21:02:00Z" },
      { lat: 50.0, lon: 30.0, t: "2026-09-15T21:00:00Z" },
    ]);
    expect(fixes).toHaveLength(2);
    expect(fixes[0]!.t).toBeLessThan(fixes[1]!.t); // відсортовано
    expect(fixes[0]!.lat).toBe(50.0);
  });

  it("биті мітки часу відкидає, не падає", () => {
    const fixes = trailToFixes([
      { lat: 50, lon: 30, t: "не дата" },
      { lat: 50.1, lon: 30, t: "2026-09-15T21:00:00Z" },
    ]);
    expect(fixes).toHaveLength(1);
  });

  it("трек із trail дає той самий вектор, що й прямий синтетичний", () => {
    // Побудуємо trail на схід і переконаємось, що курс ~90°.
    const base = Date.parse("2026-09-15T21:00:00Z");
    const trail = [0, 60, 120, 180].map((s) => ({
      lat: 50,
      lon: 30 + (180 * (s / 3600)) / (111.32 * Math.cos((50 * Math.PI) / 180)),
      t: new Date(base + s * 1000).toISOString(),
    }));
    const v = estimateVelocity(trailToFixes(trail));
    expect(v).not.toBeNull();
    expect(Math.abs(v!.bearingDeg - 90)).toBeLessThanOrEqual(3);
  });
});

describe("projectForward — конус невизначеності", () => {
  const v = { bearingDeg: 90, speedKmh: 180, confidence: 1 };

  it("проєктує на потрібну відстань за курсом", () => {
    const p = projectForward({ lat: 50, lon: 30 }, v, 10);
    // 180 км/год × 10 хв = 30 км на схід → довгота зростає, широта майже та сама
    expect(p.lon).toBeGreaterThan(30);
    expect(Math.abs(p.lat - 50)).toBeLessThan(0.05);
  });

  it("невизначеність росте з часом", () => {
    const near = projectForward({ lat: 50, lon: 30 }, v, 3);
    const far = projectForward({ lat: 50, lon: 30 }, v, 20);
    expect(far.uncertaintyKm).toBeGreaterThan(near.uncertaintyKm);
  });

  it("менша впевненість — ширший конус на тій самій дистанції", () => {
    const sure = projectForward({ lat: 50, lon: 30 }, { ...v, confidence: 1 }, 15);
    const unsure = projectForward({ lat: 50, lon: 30 }, { ...v, confidence: 0.2 }, 15);
    expect(unsure.uncertaintyKm).toBeGreaterThan(sure.uncertaintyKm);
  });
});

describe("forecastCone", () => {
  const v = { bearingDeg: 90, speedKmh: 180, confidence: 0.8 };
  it("центрлінія йде за курсом (на схід — довгота зростає), вістря попереду", () => {
    const cone = forecastCone({ lat: 50, lon: 30 }, v, { horizonMin: 18, stepMin: 3 });
    expect(cone.centerline.length).toBeGreaterThan(2);
    expect(cone.tip.lon).toBeGreaterThan(30);
    // остання точка центрлінії = вістря
    const last = cone.centerline[cone.centerline.length - 1]!;
    expect(Math.abs(last[1] - cone.tip.lon)).toBeLessThan(1e-6);
  });
  it("контур замкнений і ширший за центрлінію (конус, не лінія)", () => {
    const cone = forecastCone({ lat: 50, lon: 30 }, v);
    // ring містить носій + праву гілку + ліву — помітно більше за центрлінію
    expect(cone.ring.length).toBeGreaterThan(cone.centerline.length);
  });
  it("менша впевненість — ширший конус біля вістря", () => {
    const sure = forecastCone({ lat: 50, lon: 30 }, { ...v, confidence: 1 });
    const unsure = forecastCone({ lat: 50, lon: 30 }, { ...v, confidence: 0.2 });
    // Відстань між крайньою правою і лівою точкою (біля вістря) більша при невпевненості.
    const widthAtTip = (c: ReturnType<typeof forecastCone>) => {
      const mid = Math.floor((c.ring.length - 1) / 2);
      const r = c.ring[1]!; // перша права
      void r;
      // Беремо праву й ліву на вістрі: остання права та перша ліва навколо середини.
      const right = c.ring[mid]!;
      const left = c.ring[mid + 1]!;
      return Math.hypot(right[0] - left[0], right[1] - left[1]);
    };
    expect(widthAtTip(unsure)).toBeGreaterThan(widthAtTip(sure));
  });
});

describe("swarmVector", () => {
  it("паралельні цілі — високий курсовий консенсус (coherence ~1)", () => {
    const s = swarmVector([
      { bearingDeg: 90, speedKmh: 180, confidence: 0.8 },
      { bearingDeg: 92, speedKmh: 170, confidence: 0.7 },
      { bearingDeg: 88, speedKmh: 190, confidence: 0.9 },
    ])!;
    expect(s.bearingDeg).toBeGreaterThanOrEqual(88);
    expect(s.bearingDeg).toBeLessThanOrEqual(92);
    expect(s.coherence).toBeGreaterThan(0.95);
  });

  it("протилежні цілі — низька когерентність (рій розсипаний)", () => {
    const s = swarmVector([
      { bearingDeg: 0, speedKmh: 150, confidence: 0.8 },
      { bearingDeg: 180, speedKmh: 150, confidence: 0.8 },
    ])!;
    expect(s.coherence).toBeLessThan(0.1);
  });

  it("порожньо — null", () => {
    expect(swarmVector([])).toBeNull();
  });
});

describe("reachedPlaces", () => {
  const cities = [
    { name: "Полтава", lat: 49.59, lon: 34.55 },
    { name: "Харків", lat: 49.99, lon: 36.23 },
    { name: "Львів", lat: 49.84, lon: 24.03 },
  ];

  it("ціль на схід від Полтави курсом на Харків дає Харків із ETA", () => {
    // старт західніше Харкова, курс на схід (~90°) уздовж ~50-ї паралелі
    const v = { bearingDeg: 92, speedKmh: 180, confidence: 0.9 };
    const reached = reachedPlaces({ lat: 49.9, lon: 34.9 }, v, cities, { horizonMin: 40 });
    const names = reached.map((r) => r.name);
    expect(names).toContain("Харків");
    expect(names).not.toContain("Львів"); // у протилежному боці
  });

  it("сортування за ETA: ближче попереду", () => {
    const v = { bearingDeg: 90, speedKmh: 200, confidence: 0.9 };
    const reached = reachedPlaces({ lat: 49.7, lon: 33.0 }, v, cities, { horizonMin: 60 });
    for (let i = 1; i < reached.length; i++) {
      expect(reached[i]!.etaMin).toBeGreaterThanOrEqual(reached[i - 1]!.etaMin);
    }
  });

  it("ETA — час найближчого проходження, а не ранній дотик зростаючого конуса", () => {
    // Ціль стартує далеко на заході й летить на схід уздовж 49.99 просто до
    // Харкова (36.23). Найближче проходження — коли вона поряд із Харковом, а не
    // на першому кроці, коли конус лише почав рости.
    const v = { bearingDeg: 90, speedKmh: 180, confidence: 0.95 };
    const kharkiv = [{ name: "Харків", lat: 49.99, lon: 36.23 }];
    const from = { lat: 49.99, lon: 34.0 }; // ~160 км західніше Харкова
    const reached = reachedPlaces(from, v, kharkiv, { horizonMin: 90 });
    expect(reached).toHaveLength(1);
    // 160 км / 180 км/год ≈ 53 хв — ETA має бути в районі десятків хвилин,
    // а не 2 хв (перший крок). Дозволяємо широкий діапазон навколо істини.
    expect(reached[0]!.etaMin).toBeGreaterThan(30);
    expect(reached[0]!.missKm).toBeLessThan(25);
  });
});
