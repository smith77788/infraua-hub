import { describe, expect, it } from "bun:test";

import { buildGeoIndex, candidatesFor, queryGeoIndex } from "./geo-index";
import { distanceKm } from "./infra-types";

interface P {
  id: number;
  lat: number;
  lon: number;
}

/** Псевдовипадкові точки по всій країні — детерміновані, щоб тест не блимав. */
function points(n: number, seed = 42): P[] {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: n }, (_, id) => ({
    id,
    lat: 44.4 + rnd() * 8.2,
    lon: 22.1 + rnd() * 18.1,
  }));
}

describe("індекс не пропускає нікого", () => {
  // Головна властивість модуля. Зайвий кандидат коштує одного обчислення
  // відстані; пропущений — коштує людині сповіщення, якого вона не отримає.
  const all = points(3000);

  for (const radiusKm of [10, 50, 100, 200]) {
    it(`радіус ${radiusKm} км: збіг із повним перебором точний`, () => {
      const index = buildGeoIndex(all, 50);
      for (const probe of points(25, 7)) {
        const brute = all.filter((p) => distanceKm(probe, p) <= radiusKm).map((p) => p.id);
        const viaIndex = queryGeoIndex(index, probe, radiusKm)
          .filter((p) => distanceKm(probe, p) <= radiusKm)
          .map((p) => p.id);
        expect(new Set(viaIndex)).toEqual(new Set(brute));
      }
    });
  }

  it("точка на самій межі комірки не губиться", () => {
    // Найімовірніше місце для пропуску: людина стоїть рівно на краю комірки,
    // а ціль — у сусідній.
    const cellKm = 50;
    const edge: P[] = [
      { id: 1, lat: 50.0, lon: 30.0 },
      { id: 2, lat: 50.0 + cellKm / 111.32 - 0.0001, lon: 30.0 },
      { id: 3, lat: 50.0 + cellKm / 111.32 + 0.0001, lon: 30.0 },
    ];
    const index = buildGeoIndex(edge, cellKm);
    const found = queryGeoIndex(index, { lat: 50.0, lon: 30.0 }, 60).map((p) => p.id);
    expect(new Set(found)).toEqual(new Set([1, 2, 3]));
  });

  it("порожній індекс не кидає й нічого не вигадує", () => {
    expect(queryGeoIndex(buildGeoIndex([]), { lat: 50, lon: 30 }, 100)).toEqual([]);
  });

  it("зіпсовані координати не потрапляють в індекс", () => {
    const index = buildGeoIndex([
      { id: 1, lat: Number.NaN, lon: 30 },
      { id: 2, lat: 50, lon: Number.POSITIVE_INFINITY },
      { id: 3, lat: 50, lon: 30 },
    ]);
    expect(queryGeoIndex(index, { lat: 50, lon: 30 }, 10).map((p) => p.id)).toEqual([3]);
  });
});

describe("candidatesFor", () => {
  it("той самий підписник не повертається двічі від різних цілей", () => {
    // Під час нальоту кола цілей перетинаються; без дедупу людина
    // обраховувалась би стільки разів, скільки цілей її накрили — тобто
    // навантаження зростало б там, де воно й так найбільше.
    const subs = points(500);
    const threats = [
      { lat: 50.4, lon: 30.5 },
      { lat: 50.5, lon: 30.6 },
      { lat: 50.45, lon: 30.55 },
    ];
    const index = buildGeoIndex(subs, 50);
    const cand = candidatesFor(index, threats, 100, (p) => p.id);
    expect(new Set(cand.map((p) => p.id)).size).toBe(cand.length);
  });

  it("знаходить усіх, кого знайшов би перебір по кожній цілі", () => {
    const subs = points(1500, 99);
    const threats = points(8, 5);
    const index = buildGeoIndex(subs, 50);
    const cand = candidatesFor(index, threats, 80, (p) => p.id);
    const brute = new Set(
      subs.filter((s) => threats.some((t) => distanceKm(s, t) <= 80)).map((s) => s.id),
    );
    const viaIndex = new Set(
      cand.filter((s) => threats.some((t) => distanceKm(s, t) <= 80)).map((s) => s.id),
    );
    expect(viaIndex).toEqual(brute);
  });

  it("цілей немає — кандидатів немає", () => {
    expect(candidatesFor(buildGeoIndex(points(100)), [], 100, (p) => p.id)).toEqual([]);
  });
});
