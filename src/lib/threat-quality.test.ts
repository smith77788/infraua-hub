import { describe, expect, it } from "bun:test";

import {
  ASSUMED_UNCERTAINTY_KM,
  courseIsObserved,
  displayRadiusKm,
  EMPTY_QUALITY,
  qualityLine,
  radiusIsStated,
  readQuality,
} from "./threat-quality";

/*
 * Зразки взято з живої відповіді neptun.in.ua, а не вигадано: саме в ній
 * виявилось, що курс припущений більш ніж у половини цілей, а радіус
 * невизначеності доходить до 45 км.
 */
describe("readQuality — що джерело сказало про себе", () => {
  it("бере всі чотири заяви джерела", () => {
    const q = readQuality({
      uncertaintyKm: 4,
      positionQuality: "confirmed",
      lifecycle: "tracking",
      velocity: { bearingDeg: 157.3, speedKmh: 99.4 },
    });
    expect(q.uncertaintyKm).toBe(4);
    expect(q.position).toBe("confirmed");
    expect(q.lifecycle).toBe("tracking");
    expect(q.presumptiveCourse).toBe(false);
    expect(q.speedKmh).toBeCloseTo(99.4);
  });

  it("приблизна позиція з припущеним курсом читається як така", () => {
    const q = readQuality({
      uncertaintyKm: 45,
      positionQuality: "approx",
      lifecycle: "uncertain",
      presumptiveCourse: true,
    });
    expect(q.position).toBe("approx");
    expect(q.presumptiveCourse).toBe(true);
    expect(courseIsObserved(q)).toBe(false);
  });

  it("мовчання джерела лишається мовчанням, а не впевненістю", () => {
    const q = readQuality({});
    expect(q.uncertaintyKm).toBeNull();
    expect(q.position).toBeNull();
    expect(q.lifecycle).toBeNull();
    expect(q).toEqual(EMPTY_QUALITY);
  });

  it("сміття у полях не стає значенням", () => {
    const q = readQuality({
      uncertaintyKm: "10",
      positionQuality: "maybe",
      lifecycle: 7,
      velocity: { speedKmh: 0 },
    });
    expect(q.uncertaintyKm).toBeNull();
    expect(q.position).toBeNull();
    expect(q.lifecycle).toBeNull();
    expect(q.speedKmh).toBeNull();
  });

  it("відʼємний або нульовий радіус — не радіус", () => {
    expect(readQuality({ uncertaintyKm: 0 }).uncertaintyKm).toBeNull();
    expect(readQuality({ uncertaintyKm: -5 }).uncertaintyKm).toBeNull();
  });
});

describe("радіус показу — заявлений чи припущений", () => {
  it("заявлений джерелом береться як є", () => {
    const q = readQuality({ uncertaintyKm: 25 });
    expect(displayRadiusKm(q)).toBe(25);
    expect(radiusIsStated(q)).toBe(true);
  });

  it("мовчання дає консервативне припущення, а не нуль", () => {
    const q = readQuality({});
    expect(displayRadiusKm(q)).toBe(ASSUMED_UNCERTAINTY_KM);
    expect(radiusIsStated(q)).toBe(false);
    expect(displayRadiusKm(q)).toBeGreaterThan(0);
  });
});

describe("qualityLine — рядок для людини", () => {
  it("складає те, що сказало джерело", () => {
    const line = qualityLine(
      readQuality({ uncertaintyKm: 45, lifecycle: "uncertain", presumptiveCourse: true }),
    );
    expect(line).toBe("не підтверджена · ±45 км · курс припущений");
  });

  it("мовчить, коли джерело нічого не сказало", () => {
    expect(qualityLine(readQuality({}))).toBe("");
  });

  it("без радіуса називає якість позиції словами", () => {
    expect(qualityLine(readQuality({ positionQuality: "approx" }))).toBe("позиція приблизна");
  });

  it("підтверджену ціль із малим радіусом не обвішує застереженнями", () => {
    const line = qualityLine(
      readQuality({ uncertaintyKm: 4, positionQuality: "confirmed", lifecycle: "confirmed" }),
    );
    expect(line).toBe("підтверджена · ±4 км");
    expect(line).not.toContain("припущений");
  });
});
