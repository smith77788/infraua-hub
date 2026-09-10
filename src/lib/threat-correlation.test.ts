import { describe, expect, it } from "bun:test";

import { buildThreatGraph, correlateAirThreats, summarizeAirThreat } from "./threat-correlation";
import type { CategoryId, Facility } from "./infra-types";
import type { Threat } from "./air";
import type { SourceRole } from "./source-credibility";

function fac(id: string, category: CategoryId, lat: number, lon: number): Facility {
  return { id, name: id, category, lat, lon, source: "test" };
}

function threat(id: string, lat: number, lon: number, extra: Partial<Threat> = {}): Threat {
  return {
    id,
    name: id,
    lat,
    lon,
    source: "@ch",
    count: 1,
    since: "",
    expires: "",
    ...extra,
  };
}

describe("correlateAirThreats", () => {
  it("критичний обʼєкт із позначкою поряд отримує critical", () => {
    const facs = [fac("ps", "substation", 50.0, 30.0)];
    const threats = [threat("t1", 50.02, 30.02)]; // ~2.7 км
    const res = correlateAirThreats(facs, threats);
    expect(res).toHaveLength(1);
    expect(res[0]!.severity).toBe("critical");
    expect(res[0]!.nearestKm).toBeLessThan(5);
    expect(res[0]!.threatCount).toBe(1);
  });

  it("обʼєкт без позначок у радіусі не потрапляє в результат", () => {
    const facs = [fac("ps", "substation", 50.0, 30.0)];
    const threats = [threat("t1", 52.0, 34.0)]; // далеко
    expect(correlateAirThreats(facs, threats, { radiusKm: 30 })).toHaveLength(0);
  });

  it("активна тривога в регіоні підвищує рівень", () => {
    const facs = [fac("ps", "substation", 50.0, 30.0)];
    const threats = [threat("t1", 50.15, 30.15)]; // ~20 км → high для критичної категорії
    const base = correlateAirThreats(facs, threats);
    expect(base[0]!.severity).toBe("high");
    const boosted = correlateAirThreats(facs, threats, { alarmIds: new Set(["ps"]) });
    expect(boosted[0]!.severity).toBe("critical");
    expect(boosted[0]!.inAlarmRegion).toBe(true);
  });

  it("рахує звіти й джерела зі злитих позначок", () => {
    const facs = [fac("h", "hospital", 50.0, 30.0)];
    const threats = [
      threat("t1", 50.01, 30.01, { reports: 3, sources: ["@a", "@b"] }),
      threat("t2", 50.02, 29.99, { reports: 2, sources: ["@b", "@c"] }),
    ];
    const res = correlateAirThreats(facs, threats);
    expect(res[0]!.threatCount).toBe(2);
    expect(res[0]!.reportCount).toBe(5);
    expect(res[0]!.sources.sort()).toEqual(["@a", "@b", "@c"]);
  });

  it("сортує за терміновістю, потім за близькістю", () => {
    const facs = [
      fac("far-crit", "power_plant", 50.0, 30.0),
      fac("near-crit", "power_plant", 51.0, 32.0),
      fac("mobility", "rail", 49.0, 28.0),
    ];
    const threats = [
      threat("t1", 50.15, 30.0), // ~17 км від far-crit → high
      threat("t2", 51.01, 32.01), // ~1.3 км від near-crit → critical
      threat("t3", 49.2, 28.0), // ~22 км від rail (не критична) → medium
    ];
    const res = correlateAirThreats(facs, threats);
    expect(res.map((r) => r.facility.id)).toEqual(["near-crit", "far-crit", "mobility"]);
  });

  it("порожні входи дають порожній результат", () => {
    expect(correlateAirThreats([], [threat("t", 50, 30)])).toHaveLength(0);
    expect(correlateAirThreats([fac("a", "substation", 50, 30)], [])).toHaveLength(0);
  });

  it("summarizeAirThreat рахує рівні", () => {
    const facs = [
      fac("a", "substation", 50.0, 30.0),
      fac("b", "power_plant", 50.5, 30.5),
      fac("c", "rail", 51.0, 31.0),
    ];
    const threats = [threat("t1", 50.0, 30.0), threat("t2", 50.5, 30.5), threat("t3", 51.2, 31.0)];
    const sum = summarizeAirThreat(correlateAirThreats(facs, threats));
    expect(sum.total).toBe(3);
    expect(sum.critical).toBe(2);
  });
});

describe("buildThreatGraph", () => {
  it("будує вузли обʼєкт/ціль/канал і звʼязки між ними", () => {
    const facs = [fac("ps", "substation", 50.0, 30.0)];
    const threats = [
      threat("t1", 50.01, 30.01, { sources: ["@a", "@b"] }),
      threat("t2", 50.02, 29.99, { source: "@c" }),
    ];
    const corr = correlateAirThreats(facs, threats);
    const g = buildThreatGraph(corr, threats);
    const kinds = g.nodes.reduce<Record<string, number>>((m, n) => {
      m[n.kind] = (m[n.kind] ?? 0) + 1;
      return m;
    }, {});
    expect(kinds["asset"]).toBe(1);
    expect(kinds["threat"]).toBe(2);
    expect(kinds["channel"]).toBe(3); // @a, @b, @c
    expect(g.edges.filter((e) => e.kind === "threatens")).toHaveLength(2);
    expect(g.edges.filter((e) => e.kind === "reported-by")).toHaveLength(3);
  });

  it("виявляє схід кількох цілей на один обʼєкт (ступінь обʼєкта)", () => {
    const facs = [fac("hub", "power_plant", 50.0, 30.0)];
    const threats = [
      threat("t1", 50.01, 30.0),
      threat("t2", 49.99, 30.0),
      threat("t3", 50.0, 30.02),
    ];
    const g = buildThreatGraph(correlateAirThreats(facs, threats), threats);
    const asset = g.nodes.find((n) => n.kind === "asset")!;
    expect(asset.degree).toBe(3);
    expect(asset.severity).toBe("critical");
  });

  it("порожня кореляція — порожній граф", () => {
    expect(buildThreatGraph([], []).nodes).toHaveLength(0);
  });
});

describe("достовірність у кореляції", () => {
  const roleOf = (source: string) =>
    (({ radar_a: "watch", radar_b: "watch", wire: "general" }) as Record<string, SourceRole>)[
      source
    ] ?? "unknown";

  const hospital: Facility = {
    id: "h1",
    name: "Лікарня",
    category: "hospital",
    lat: 50,
    lon: 30,
    source: "test",
  };

  const markFrom = (sources: string[]): Threat => ({
    id: "t1",
    name: "Київ",
    lat: 50.01,
    lon: 30.01,
    type: "shahed",
    source: sources[0]!,
    sources,
    reports: sources.length,
    count: sources.length,
    since: "2026-09-10T10:00:00Z",
    expires: "2026-09-10T11:00:00Z",
  });

  it("не дає одному переказу того самого рівня, що й трьом спостереженням", () => {
    const rumour = correlateAirThreats([hospital], [markFrom(["wire"])], { roleOf });
    const watched = correlateAirThreats([hospital], [markFrom(["radar_a", "radar_b"])], { roleOf });

    expect(rumour[0]!.severity).toBe("high");
    expect(watched[0]!.severity).toBe("critical");
    expect(rumour[0]!.credibility.code).toBe("D3");
    expect(watched[0]!.credibility.code).toBe("C2");
  });

  it("піднімає переказ, щойно його підтверджує офіційна тривога", () => {
    const confirmed = correlateAirThreats([hospital], [markFrom(["wire"])], {
      roleOf,
      alarmIds: new Set(["h1"]),
    });
    expect(confirmed[0]!.severity).toBe("critical");
    expect(confirmed[0]!.credibility.independentSources).toBe(2);
  });

  it("не глушить джерело лише через те, що його ролі ми не знаємо", () => {
    const unknown = correlateAirThreats([hospital], [markFrom(["невідомий"])], { roleOf });
    expect(unknown[0]!.severity).toBe("critical");
  });

  it("працює й без переліку ролей, просто знаючи менше", () => {
    const noRoles = correlateAirThreats([hospital], [markFrom(["wire"])]);
    expect(noRoles[0]!.credibility.reliability).toBe("F");
    expect(noRoles[0]!.severity).toBe("critical");
  });
});
