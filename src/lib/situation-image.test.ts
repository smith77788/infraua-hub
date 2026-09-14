import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { situationSvg, situationSvgZoom } from "./situation-image";

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

describe("situationSvgZoom", () => {
  it("зумована карта: валідний SVG, малює ціль у в'юпорті", () => {
    const svg = situationSvgZoom(
      [
        {
          id: "a",
          name: "",
          lat: 49.6,
          lon: 34.5,
          source: "n",
          count: 1,
          since: "",
          expires: "",
          type: "shahed",
          heading: 0,
        } as never,
      ],
      { lat: 49.59, lon: 34.55 },
      70,
    );
    expect(svg.startsWith("<svg")).toBe(true);
    // приціл на місті (коло + перехрестя) є завжди
    expect(svg).toContain("<line ");
    // ціль поблизу центра потрапила у в'юпорт
    expect(svg).toContain("<circle ");
  });

  it("ціль далеко за межами в'юпорта не малюється", () => {
    const svg = situationSvgZoom(
      [
        {
          id: "b",
          name: "",
          lat: 46.4,
          lon: 30.7,
          source: "n",
          count: 1,
          since: "",
          expires: "",
          type: "shahed",
        } as never,
      ],
      { lat: 50.9, lon: 34.8 },
      50,
    );
    // лише приціл-лінії, без позначок-glow (немає дрон-крапки поза в'юпортом)
    expect((svg.match(/<circle /g) ?? []).length).toBe(1);
  });
});

describe("треки на картинці", () => {
  const points = [
    { lat: 51.5, lon: 31.3 },
    { lat: 50.9, lon: 31.0 },
    { lat: 50.4, lon: 30.6 },
  ];

  it("шлях малюється лінією — це те, чого не показує стрілка", () => {
    const svg = situationSvg([], [{ type: "shahed", points }]);
    expect(svg).toContain("<path");
    expect(svg).toContain('stroke-linecap="round"');
  });

  it("одна точка — це не шлях, лінії немає", () => {
    const one = situationSvg([], [{ type: "shahed", points: points.slice(0, 1) }]);
    const none = situationSvg([], []);
    expect(one).toBe(none);
  });

  it("трек не добудовується вперед: остання точка лінії — остання відома", () => {
    // Продовження за останній фікс було б вигаданим маршрутом із виглядом
    // заміряного — саме тим, чим грішать стрілки в моніторах.
    const svg = situationSvg([], [{ type: "shahed", points }]);
    const d = /d="(M[^"]+)"/.exec(svg.slice(svg.indexOf("stroke-linecap") - 400))?.[1] ?? "";
    expect(d.split("L")).toHaveLength(points.length);
  });
});
