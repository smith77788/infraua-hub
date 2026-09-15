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

/*
 * Припущені курси узгоджені між собою — вони виводяться з того самого
 * загального напрямку нальоту. Тому вони не просто додають шуму, а роздувають
 * міру узгодженості, яка й вирішує, чи давати прогноз узагалі: прогноз
 * виглядав тим упевненішим, чим менше під ним було спостережень.
 */
describe("swarmForecast — рахує лише спостережені курси", () => {
  const presumed = {
    uncertaintyKm: 25,
    position: "approx" as const,
    lifecycle: "uncertain" as const,
    presumptiveCourse: true,
    speedKmh: null,
  };

  it("самі припущені курси прогнозу не дають", () => {
    const only = [0, 1, 2, 3].map((i) =>
      threat({ id: `p${i}`, lat: 47 + i * 0.1, heading: 315, quality: presumed }),
    );
    expect(swarmForecast(only, cities)).toBeNull();
  });

  it("припущені не добирають кількості до порогу", () => {
    const mixed = [
      threat({ id: "o1", lat: 47, heading: 315 }),
      threat({ id: "o2", lat: 47.1, heading: 318 }),
      threat({ id: "p1", lat: 47.2, heading: 316, quality: presumed }),
      threat({ id: "p2", lat: 47.3, heading: 314, quality: presumed }),
    ];
    // Спостережених лише дві — менше за поріг у три, попри чотири з курсом.
    expect(swarmForecast(mixed, cities)).toBeNull();
  });

  it("прогноз каже, скільки курсів відкинуто як припущені", () => {
    const f = swarmForecast(
      [
        threat({ id: "o1", lat: 47, heading: 315 }),
        threat({ id: "o2", lat: 47.1, heading: 318 }),
        threat({ id: "o3", lat: 47.2, heading: 312 }),
        threat({ id: "p1", lat: 47.3, heading: 316, quality: presumed }),
      ],
      cities,
    );
    expect(f).not.toBeNull();
    expect(f!.count).toBe(3);
    expect(f!.presumed).toBe(1);
  });

  it("без припущених лічильник нульовий", () => {
    const f = swarmForecast(
      [0, 1, 2].map((i) => threat({ id: `o${i}`, lat: 47 + i * 0.1, heading: 315 + i })),
      cities,
    );
    expect(f!.presumed).toBe(0);
  });
});
