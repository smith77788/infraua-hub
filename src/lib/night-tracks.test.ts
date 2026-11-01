import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { keepNights, KEEP_NIGHTS, nightKeyOf, nightStart, NightTracks } from "./night-tracks";

function t(id: string, lat: number, lon: number, type: Threat["type"] = "shahed"): Threat {
  return {
    id,
    name: id,
    lat,
    lon,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    ...(type ? { type } : {}),
  };
}

describe("nightKeyOf — ніч через північ — одна ніч", () => {
  it("23:00 31.10 і 03:00 01.11 за Києвом — та сама ніч «2026-10-31»", () => {
    expect(nightKeyOf(Date.parse("2026-10-31T21:00:00Z"))).toBe("2026-10-31");
    expect(nightKeyOf(Date.parse("2026-11-01T01:00:00Z"))).toBe("2026-10-31");
  });

  it("полудень за Києвом — межа ночей", () => {
    const start = nightStart("2026-11-01");
    expect(nightKeyOf(start)).toBe("2026-11-01");
    expect(nightKeyOf(start - 60_000)).toBe("2026-10-31");
  });
});

describe("NightTracks — одна лінія на ціль", () => {
  const start = nightStart("2026-10-31");

  it("нова точка — лише коли ціль зрушила на 3 км і більше", () => {
    const n = new NightTracks("2026-10-31", start);
    n.observe([t("a", 50, 30)], start + 60_000);
    n.observe([t("a", 50.01, 30)], start + 120_000); // ~1 км — та сама точка
    n.observe([t("a", 50.05, 30)], start + 180_000); // ~5.5 км — нова
    const tr = n.payload().tracks[0]!;
    expect(tr.pts).toHaveLength(2);
    expect(tr.pts[1]![2]).toBe(3);
  });

  it("тип — останній відомий", () => {
    const n = new NightTracks("2026-10-31", start);
    n.observe([t("a", 50, 30, "shahed")], start);
    n.observe([t("a", 50, 30, "reactive")], start + 60_000);
    expect(n.payload().tracks[0]!.type).toBe("reactive");
  });

  it("переживає збереження; чужа ніч чи сміття — порожня ніч", () => {
    const n = new NightTracks("2026-10-31", start);
    n.observe([t("a", 50, 30), t("b", 49, 31)], start);
    const json = JSON.parse(JSON.stringify(n.payload()));
    expect(NightTracks.fromPayload(json, "2026-10-31", start).size).toBe(2);
    expect(NightTracks.fromPayload(json, "2026-11-01", start).size).toBe(0);
    expect(NightTracks.fromPayload("сміття", "2026-10-31", start).size).toBe(0);
  });
});

describe("keepNights — 30 ночей", () => {
  it("лишає найновіші без повторів", () => {
    const keys = Array.from({ length: 40 }, (_, i) =>
      new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10),
    );
    const kept = keepNights([...keys, keys[39]!]);
    expect(kept).toHaveLength(KEEP_NIGHTS);
    expect(kept[0]).toBe(keys[39]);
  });
});
