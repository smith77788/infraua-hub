import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { clusterThreats, updateWaves, type Wave } from "./waves";

function threat(lat: number, lon: number, p: Partial<Threat> = {}): Threat {
  return {
    id: p.id ?? `${lat},${lon}`,
    name: "",
    lat,
    lon,
    source: "n",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

describe("clusterThreats", () => {
  it("сусідні позначки — одна хвиля", () => {
    const c = clusterThreats([threat(50, 30), threat(50.1, 30.1), threat(50.05, 30.05)]);
    expect(c).toHaveLength(1);
    expect(c[0]!.count).toBe(3);
  });

  it("дві далекі групи — дві хвилі", () => {
    const c = clusterThreats([
      threat(51, 30),
      threat(51.1, 30.1),
      threat(47, 37), // інший кінець країни
      threat(47.1, 37.1),
    ]);
    expect(c).toHaveLength(2);
  });

  it("ланцюжок сусідів злипається (транзитивність одинарного зв'язку)", () => {
    // A-B близькі, B-C близькі, A-C далекі — усе одно одна хвиля
    const c = clusterThreats([threat(50, 30), threat(50, 30.5), threat(50, 31)], 45);
    expect(c).toHaveLength(1);
    expect(c[0]!.count).toBe(3);
  });

  it("домінантний тип хвилі — найчастіший", () => {
    const c = clusterThreats([
      threat(50, 30, { type: "shahed" }),
      threat(50.1, 30, { type: "shahed" }),
      threat(50.05, 30.05, { type: "missile" }),
    ]);
    expect(c[0]!.dominantType).toBe("shahed");
  });
});

describe("updateWaves — життєвий цикл", () => {
  it("перший тик — усі хвилі нові, з firstSeen=now", () => {
    const clusters = clusterThreats([threat(50, 30), threat(50.1, 30)]);
    const waves = updateWaves([], clusters, 1000);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.status).toBe("new");
    expect(waves[0]!.firstSeen).toBe(1000);
  });

  it("хвиля, що зрушила, зберігає id (та сама хвиля, не нова)", () => {
    const first = updateWaves([], clusterThreats([threat(50, 30), threat(50.1, 30)]), 1000);
    const id = first[0]!.id;
    // трохи зсунулись — у межах matchKm
    const second = updateWaves(
      first,
      clusterThreats([threat(50.2, 30.1), threat(50.3, 30.1)]),
      2000,
    );
    expect(second[0]!.id).toBe(id);
    expect(second[0]!.status).toBe("active");
    expect(second[0]!.firstSeen).toBe(1000); // від першої появи
  });

  it("ріст групи → trend growing і оновлений пік", () => {
    const first = updateWaves([], clusterThreats([threat(50, 30)]), 1000);
    const grown = updateWaves(
      first,
      clusterThreats([threat(50, 30), threat(50.1, 30), threat(50.05, 30.05)]),
      2000,
    );
    expect(grown[0]!.trend).toBe("growing");
    expect(grown[0]!.peakCount).toBe(3);
  });

  it("зникла група → згасає в межах grace, потім зникає зовсім", () => {
    const first = updateWaves([], clusterThreats([threat(50, 30), threat(50.1, 30)]), 1000);
    // наступний тик без цієї групи, у межах expire
    const fading = updateWaves(first, [], 1000 + 60_000, { expireMs: 4 * 60_000 });
    expect(fading).toHaveLength(1);
    expect(fading[0]!.status).toBe("fading");
    // ще пізніше — поза grace, зникає
    const gone = updateWaves(fading, [], 1000 + 10 * 60_000, { expireMs: 4 * 60_000 });
    expect(gone).toHaveLength(0);
  });

  it("дві окремі групи ведуться як дві різні хвилі зі своїми id", () => {
    const clusters = clusterThreats([
      threat(51, 30),
      threat(51.1, 30),
      threat(47, 37),
      threat(47.1, 37),
    ]);
    const waves = updateWaves([], clusters, 1000);
    expect(waves).toHaveLength(2);
    expect(new Set(waves.map((w: Wave) => w.id)).size).toBe(2);
  });
});
