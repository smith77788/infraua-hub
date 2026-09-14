import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { situationSvg } from "./situation-image";

function threat(p: Partial<Threat>): Threat {
  return {
    id: "t",
    name: "",
    lat: 49,
    lon: 32,
    source: "neptun",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

describe("situationSvg", () => {
  it("малює контур країни і по позначці на кожну ціль", () => {
    const svg = situationSvg([
      threat({ lat: 46.6, lon: 32.6, type: "shahed", heading: 0 }),
      threat({ lat: 49.9, lon: 36.2, type: "missile" }),
    ]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    // Кожна позначка несе glow-коло; дрон — силует, ракета — ромб.
    expect((svg.match(/<circle /g) ?? []).length).toBe(2);
  });

  it("порожнє небо — валідний SVG без позначок", () => {
    const svg = situationSvg([]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("<circle ");
  });

  it("курс на зображенні: стрілка лише коли heading відомий", () => {
    // Відомий курс → повернутий дрон (rotate).
    const withCourse = situationSvg([threat({ lat: 49, lon: 32, type: "shahed", heading: 90 })]);
    expect(withCourse).toContain("rotate(90)");
    // Невідомий курс → НЕ вигадуємо напрямок (без rotate).
    const noCourse = situationSvg([threat({ lat: 49, lon: 32, type: "shahed" })]);
    expect(noCourse).not.toContain("rotate(");
  });
});
