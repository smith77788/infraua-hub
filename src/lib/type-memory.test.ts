import { describe, expect, it } from "bun:test";

import type { Threat, ThreatType } from "./air";
import { TTL_MS, TypeMemory } from "./type-memory";

const T0 = Date.parse("2026-10-31T21:45:00Z");

function t(id: string, type: ThreatType): Threat {
  return {
    id,
    name: id,
    lat: 49,
    lon: 31,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    type,
  };
}

describe("TypeMemory — реактивний лишається реактивним до кінця польоту", () => {
  it("згадка застаріла, а трек летить далі — тип не губиться (знімок 01.11 0:23)", () => {
    const m = new TypeMemory();
    m.note([t("zven", "reactive")], T0);
    expect(m.apply([t("zven", "shahed")], T0 + 40 * 60_000)[0]!.type).toBe("reactive");
  });

  it("інші треки не чіпає", () => {
    const m = new TypeMemory();
    m.note([t("zven", "reactive")], T0);
    expect(m.apply([t("other", "shahed")], T0 + 60_000)[0]!.type).toBe("shahed");
  });

  it("лише підвищує: ракету чи «Бандероль» реактивним не робить", () => {
    const m = new TypeMemory();
    m.note([t("a", "reactive")], T0);
    expect(m.apply([t("a", "banderol")], T0 + 60_000)[0]!.type).toBe("banderol");
    expect(m.apply([t("a", "cruise")], T0 + 60_000)[0]!.type).toBe("cruise");
  });

  it("«Бандероль» теж памʼятається", () => {
    const m = new TypeMemory();
    m.note([t("b", "banderol")], T0);
    expect(m.apply([t("b", "shahed")], T0 + 30 * 60_000)[0]!.type).toBe("banderol");
  });

  it("звичайні типи не запамʼятовуються", () => {
    const m = new TypeMemory();
    m.note([t("s", "shahed"), t("c", "cruise")], T0);
    expect(m.size).toBe(0);
  });

  it("через TTL після останнього кадру памʼять зникає", () => {
    const m = new TypeMemory();
    m.note([t("zven", "reactive")], T0);
    expect(m.apply([t("zven", "shahed")], T0 + TTL_MS + 60_000)[0]!.type).toBe("shahed");
  });
});
