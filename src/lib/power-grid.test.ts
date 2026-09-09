import { describe, expect, it } from "bun:test";

import { buildObservedGraph, mergeGraphs, parsePowerLines, powerLineQuery } from "./power-grid";
import { buildGraph, type Facility } from "./infra-types";
import { isObserved, summarize } from "./provenance";

function facility(id: string, lat: number, lon: number, category: Facility["category"]): Facility {
  return { id, name: id, category, lat, lon, source: "test" };
}

/** Дві підстанції приблизно за 11 км одна від одної. */
const SUB_A = facility("sub-a", 50.4, 30.5, "substation");
const SUB_B = facility("sub-b", 50.5, 30.5, "substation");
const PLANT = facility("plant", 50.45, 30.6, "power_plant");

function line(id: number, from: [number, number], to: [number, number], voltage?: string) {
  return {
    type: "way",
    id,
    ...(voltage ? { tags: { power: "line", voltage } } : { tags: { power: "line" } }),
    geometry: [
      { lat: from[0], lon: from[1] },
      { lat: to[0], lon: to[1] },
    ],
  };
}

describe("parsePowerLines", () => {
  it("розбирає лінію з геометрією і напругою", () => {
    const lines = parsePowerLines({ elements: [line(1, [50.4, 30.5], [50.5, 30.5], "330000")] });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe(1);
    expect(lines[0]!.voltage).toBe(330_000);
    expect(lines[0]!.geometry).toHaveLength(2);
  });

  it("бере найвищу напругу зі списку через крапку з комою", () => {
    // Лінія, підвішена на спільних опорах, тегується "330000;110000";
    // роль у мережі визначає вища напруга.
    const lines = parsePowerLines({ elements: [line(2, [50, 30], [51, 30], "110000;330000")] });
    expect(lines[0]!.voltage).toBe(330_000);
  });

  it("відкидає елементи без геометрії або з однією точкою", () => {
    const payload = {
      elements: [
        { type: "way", id: 3, tags: { power: "line" } },
        { type: "way", id: 4, geometry: [{ lat: 50, lon: 30 }] },
      ],
    };
    expect(parsePowerLines(payload)).toEqual([]);
  });

  it("переживає відповідь не того формату, а не падає", () => {
    // Overpass під навантаженням віддає HTML замість JSON — перевірено на
    // живому сервісі. Парсер має це пережити, бо інакше падає весь екран.
    expect(parsePowerLines("<html>rate limited</html>")).toEqual([]);
    expect(parsePowerLines(null)).toEqual([]);
    expect(parsePowerLines({ elements: "not an array" })).toEqual([]);
  });

  it("не вигадує напругу, якщо тег відсутній або нечисловий", () => {
    const lines = parsePowerLines({
      elements: [
        line(5, [50, 30], [51, 30]),
        { ...line(6, [50, 30], [51, 30]), tags: { power: "line", voltage: "невідомо" } },
      ],
    });
    expect(lines[0]!.voltage).toBeUndefined();
    expect(lines[1]!.voltage).toBeUndefined();
  });
});

describe("powerLineQuery", () => {
  it("просить JSON, фільтрує від 110 кВ і повертає геометрію", () => {
    const q = powerLineQuery({ south: 50, west: 30, north: 52, east: 32 });
    expect(q).toContain("[out:json]");
    expect(q).toContain('"power"="line"');
    expect(q).toContain("(50,30,52,32)");
    // Без geom ребро не побудувати — кінці ліній беруться саме звідти.
    expect(q).toContain("out tags geom");
  });
});

describe("buildObservedGraph", () => {
  it("зводить лінію з обʼєктами на обох кінцях у ребро з посиланням на OSM", () => {
    const result = buildObservedGraph(
      [SUB_A, SUB_B],
      parsePowerLines({ elements: [line(10, [50.4, 30.5], [50.5, 30.5], "110000")] }),
      "2026-09-09",
    );

    expect(result.edges).toHaveLength(1);
    expect(result.matchedLines).toBe(1);
    const [edge] = result.edges;
    expect(new Set([edge!.from, edge!.to])).toEqual(new Set(["sub-a", "sub-b"]));

    const p = edge!.provenance;
    expect(isObserved(p)).toBe(true);
    if (isObserved(p)) {
      // Посилання — це вся суть: твердження можна відкрити в OSM і перевірити.
      expect(p.ref).toBe("way/10");
      expect(p.source).toBe("OpenStreetMap");
      expect(p.attributes?.["voltage"]).toBe(110_000);
    }
  });

  it("не будує ребро, якщо кінець лінії далеко від будь-якого обʼєкта", () => {
    const result = buildObservedGraph(
      [SUB_A, SUB_B],
      parsePowerLines({ elements: [line(11, [50.4, 30.5], [49.0, 29.0], "110000")] }),
      "2026-09-09",
    );
    expect(result.edges).toHaveLength(0);
    expect(result.unmatchedLines).toBe(1);
  });

  it("не зациклює лінію на той самий обʼєкт", () => {
    const result = buildObservedGraph(
      [SUB_A],
      parsePowerLines({ elements: [line(12, [50.4, 30.5], [50.4001, 30.5001], "110000")] }),
      "2026-09-09",
    );
    expect(result.edges).toHaveLength(0);
  });

  it("згортає паралельні лінії між тією самою парою в одне ребро", () => {
    // Дві ланцюги на спільній трасі — це один звʼязок у топології.
    const result = buildObservedGraph(
      [SUB_A, SUB_B],
      parsePowerLines({
        elements: [
          line(13, [50.4, 30.5], [50.5, 30.5], "110000"),
          line(14, [50.5, 30.5], [50.4, 30.5], "330000"),
        ],
      }),
      "2026-09-09",
    );
    expect(result.edges).toHaveLength(1);
  });

  it("повертає порожній граф на порожньому вході, а не падає", () => {
    expect(buildObservedGraph([], [], "2026-09-09").edges).toEqual([]);
    expect(buildObservedGraph([SUB_A], [], "2026-09-09").edges).toEqual([]);
  });
});

describe("mergeGraphs", () => {
  it("відкидає здогадку про вузол, у якого вже є спостережена лінія", () => {
    const observed = buildObservedGraph(
      [SUB_A, SUB_B, PLANT],
      parsePowerLines({ elements: [line(20, [50.4, 30.5], [50.5, 30.5], "110000")] }),
      "2026-09-09",
    );
    expect(observed.edges).toHaveLength(1);

    const inferred = buildGraph([SUB_A, SUB_B, PLANT]);
    expect(inferred.length).toBeGreaterThan(0);

    const merged = mergeGraphs(observed.edges, inferred);
    const groundedNodes = new Set([observed.edges[0]!.from, observed.edges[0]!.to]);
    for (const edge of merged) {
      if (isObserved(edge.provenance)) continue;
      // Про вузол, чиє живлення ми бачимо, здогадок бути не повинно.
      expect(groundedNodes.has(edge.to)).toBe(false);
    }
  });

  it("зберігає виведені ребра там, де фактів немає", () => {
    const inferred = buildGraph([SUB_A, SUB_B, PLANT]);
    const merged = mergeGraphs([], inferred);
    expect(merged).toEqual(inferred);
  });

  it("піднімає частку фактів у графі", () => {
    const facilities = [SUB_A, SUB_B, PLANT];
    const observed = buildObservedGraph(
      facilities,
      parsePowerLines({ elements: [line(21, [50.4, 30.5], [50.5, 30.5], "110000")] }),
      "2026-09-09",
    );
    const onlyInferred = summarize(buildGraph(facilities));
    const withFacts = summarize(mergeGraphs(observed.edges, buildGraph(facilities)));

    expect(onlyInferred.observedShare).toBe(0);
    expect(withFacts.observedShare).toBeGreaterThan(0);
    expect(withFacts.meanConfidence).toBeGreaterThan(onlyInferred.meanConfidence);
  });
});

describe("buildGraph (виведений кістяк)", () => {
  it("позначає кожне своє ребро як припущення, а не факт", () => {
    // Це і є суть примітиву: жодне ребро цього графа не має видавати себе
    // за спостереження.
    for (const edge of buildGraph([SUB_A, SUB_B, PLANT])) {
      expect(edge.provenance.kind).toBe("inferred");
      if (edge.provenance.kind === "inferred") {
        expect(edge.provenance.confidence).toBeLessThan(0.5);
        expect(edge.provenance.caveat.length).toBeGreaterThan(0);
      }
    }
  });
});
