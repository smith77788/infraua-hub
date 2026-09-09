import { describe, expect, it } from "bun:test";

import { fuseThreats, type Threat } from "./air";

function t(id: string, lat: number, lon: number, extra: Partial<Threat> = {}): Threat {
  return {
    id,
    name: id,
    lat,
    lon,
    source: "@ch",
    count: 1,
    since: "2026-09-09T10:00:00.000Z",
    expires: "",
    ...extra,
  };
}

describe("fuseThreats", () => {
  it("зливає той самий пункт (однаковий osmId) від різних каналів", () => {
    const out = fuseThreats([
      t("a", 50.45, 30.52, { osmId: 26150422, source: "radar_top_ua" }),
      t("b", 50.451, 30.521, { osmId: 26150422, source: "chyste_nebo" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reports).toBe(2);
    expect(out[0]!.sources!.sort()).toEqual(["chyste_nebo", "radar_top_ua"]);
  });

  it("зливає сусідні позначки в радіусі", () => {
    const out = fuseThreats([t("a", 50.45, 30.52), t("b", 50.47, 30.54)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reports).toBe(2);
  });

  it("не зливає далекі різні пункти", () => {
    const out = fuseThreats([
      t("a", 50.45, 30.52, { osmId: 1 }),
      t("b", 46.48, 30.74, { osmId: 2 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("ядром стає найсвіжіший сигнал, lastSeen — час останнього", () => {
    const out = fuseThreats([
      t("old", 50.45, 30.52, { since: "2026-09-09T10:00:00.000Z", name: "old" }),
      t("new", 50.46, 30.53, { since: "2026-09-09T10:30:00.000Z", name: "new" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("new");
    expect(out[0]!.lastSeen).toBe("2026-09-09T10:30:00.000Z");
  });
});
