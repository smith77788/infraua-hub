import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { swarmForecast } from "./swarm";

function threat(p: Partial<Threat>): Threat {
  return {
    id: "t",
    name: "",
    lat: 47,
    lon: 35,
    source: "neptun",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

const cities = [
  { name: "Полтавщина", lat: 49.59, lon: 34.55 },
  { name: "Сумщина", lat: 50.9, lon: 34.8 },
  { name: "Львівщина", lat: 49.84, lon: 24.03 },
];

describe("swarmForecast", () => {
  it("узгоджений рій на північ → курс і наступні області", () => {
    const f = swarmForecast(
      [
        threat({ lat: 48.0, lon: 34.5, heading: 0 }),
        threat({ lat: 48.1, lon: 34.6, heading: 5 }),
        threat({ lat: 48.2, lon: 34.4, heading: 355 }),
      ],
      cities,
    )!;
    expect(f.course).toBe("на північ");
    expect(f.next.length).toBeGreaterThan(0);
    // Львівщина далеко на захід — не має бути «на черзі».
    expect(f.next).not.toContain("Львівщина");
  });

  it("замало цілей — прогнозу немає", () => {
    expect(swarmForecast([threat({ heading: 0 }), threat({ heading: 0 })], cities)).toBeNull();
  });

  it("курси надто різні — прогнозу немає (не вигадуємо)", () => {
    const f = swarmForecast(
      [
        threat({ lat: 48, lon: 34, heading: 0 }),
        threat({ lat: 48, lon: 34, heading: 120 }),
        threat({ lat: 48, lon: 34, heading: 240 }),
      ],
      cities,
    );
    expect(f).toBeNull();
  });
});
