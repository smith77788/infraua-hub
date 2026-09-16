import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { observedVelocity, subsetVector, swarmForecast } from "./swarm-forecast";

const NOW = Date.parse("2026-09-16T21:10:00Z");

/** Ціль із прямим трейлом на схід зі швидкістю km/h, останній фікс — щойно. */
function eastbound(id: string, lat: number, lon0: number, kmh = 180, points = 5): Threat {
  const trail = [];
  for (let i = points - 1; i >= 0; i--) {
    const secAgo = i * 60;
    const km = (kmh * ((points - 1 - i) * 60)) / 3600;
    const lon = lon0 + km / (111.32 * Math.cos((lat * Math.PI) / 180));
    trail.push({ lat, lon, t: new Date(NOW - secAgo * 1000).toISOString() });
  }
  return {
    id,
    name: "",
    lat,
    lon: trail[trail.length - 1]!.lon,
    source: "n",
    count: 1,
    since: "",
    expires: "",
    type: "shahed",
    trail,
  };
}

describe("observedVelocity", () => {
  it("прямий трейл на схід → курс ~90°, спостережений", () => {
    const v = observedVelocity(eastbound("a", 50, 30), NOW);
    expect(v).not.toBeNull();
    expect(Math.abs(v!.bearingDeg - 90)).toBeLessThanOrEqual(5);
  });

  it("без трейла — null (немає спостереженого руху)", () => {
    const t: Threat = {
      id: "x",
      name: "",
      lat: 50,
      lon: 30,
      source: "n",
      count: 1,
      since: "",
      expires: "",
      type: "shahed",
      heading: 90,
    };
    expect(observedVelocity(t, NOW)).toBeNull(); // heading є, але рух не бачений
  });

  it("битий фікс-стрибок (помилка ототожнення) не перекошує курс", () => {
    const t = eastbound("j", 50, 30);
    // Вставляємо телепорт на інший кінець області серед трейла.
    t.trail!.splice(2, 0, {
      lat: 47,
      lon: 37,
      t: new Date(NOW - 150 * 1000).toISOString(),
    });
    const v = observedVelocity(t, NOW);
    expect(v).not.toBeNull();
    // Курс лишається східним, а не смикається до викиду.
    expect(Math.abs(v!.bearingDeg - 90)).toBeLessThanOrEqual(20);
  });
});

describe("swarmForecast", () => {
  it("кілька східних цілей → рій іде на схід, tracked рахує лише спостережені", () => {
    const f = swarmForecast(
      [eastbound("a", 50, 30), eastbound("b", 50.1, 30.2), eastbound("c", 49.9, 30.1)],
      NOW,
    );
    expect(f).not.toBeNull();
    expect(f!.tracked).toBe(3);
    expect(Math.abs(f!.swarm.bearingDeg - 90)).toBeLessThanOrEqual(8);
    expect(f!.swarm.coherence).toBeGreaterThan(0.9);
  });

  it("жодного спостереженого руху → null", () => {
    const still: Threat = {
      id: "s",
      name: "",
      lat: 50,
      lon: 30,
      source: "n",
      count: 1,
      since: "",
      expires: "",
      type: "shahed",
    };
    expect(swarmForecast([still], NOW)).toBeNull();
  });
});

describe("subsetVector", () => {
  it("вектор членів однієї хвилі", () => {
    const sw = subsetVector([eastbound("a", 50, 30), eastbound("b", 50.1, 30)], NOW);
    expect(sw).not.toBeNull();
    expect(Math.abs(sw!.bearingDeg - 90)).toBeLessThanOrEqual(8);
  });
});
