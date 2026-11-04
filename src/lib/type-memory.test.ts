import { describe, expect, it } from "bun:test";

import type { Threat, ThreatType } from "./air";
import { EMPTY_QUALITY } from "./threat-quality";
import { refuteJetBySpeed, TTL_MS, TypeMemory } from "./type-memory";

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

describe("TypeMemory — на томі й щоденне прибирання", () => {
  it("переживає перезапуск: toState → fromState", () => {
    const m = new TypeMemory();
    m.note([t("zven", "reactive"), t("b", "banderol")], T0);
    const back = TypeMemory.fromState(JSON.parse(JSON.stringify(m.toState(T0))), T0 + 60_000);
    expect(back.apply([t("zven", "shahed")], T0 + 60_000)[0]!.type).toBe("reactive");
    expect(back.apply([t("b", "shahed")], T0 + 60_000)[0]!.type).toBe("banderol");
  });

  it("не відновлює вчорашнє, бите й чуже", () => {
    const raw = [
      ["old", "reactive", T0 - TTL_MS - 60_000],
      ["bad", "reactive", "вчора"],
      ["cruise", "cruise", T0],
      "сміття",
      ["ok", "reactive", T0 - 60_000],
    ];
    const m = TypeMemory.fromState(raw, T0);
    expect(m.size).toBe(1);
    expect(TypeMemory.fromState("не масив", T0).size).toBe(0);
  });

  it("щоденне прибирання викидає відлетілі треки й лишає ті, що летять", () => {
    const m = new TypeMemory();
    m.note([t("gone", "reactive")], T0);
    m.note([t("flying", "reactive")], T0 + TTL_MS);
    expect(m.cleanup(T0 + TTL_MS + 60_000)).toBe(1);
    expect(m.size).toBe(1);
  });

  it("відновлення зливається з тим, що карта встигла записати", () => {
    const live = new TypeMemory();
    live.note([t("new", "reactive")], T0 + 60_000);
    const disk = new TypeMemory();
    disk.note([t("old", "banderol")], T0);
    live.absorb(TypeMemory.fromState(disk.toState(T0), T0 + 60_000));
    expect(live.size).toBe(2);
  });
});

describe("refuteJetBySpeed — замір швидкості сильніший за слово каналу", () => {
  const q = (speedKmh: number | null) => ({ ...EMPTY_QUALITY, speedKmh });

  it("«реактивний (канал)» при заміряних 108 км/год — шахед, і памʼять його забуває", () => {
    const m = new TypeMemory();
    m.note([t("borsch", "reactive")], T0);
    const [out] = refuteJetBySpeed(
      [{ ...t("borsch", "reactive"), typeFromChannels: true, quality: q(108) }],
      m,
    );
    expect(out!.type).toBe("shahed");
    expect(out!.typeFromChannels).toBeUndefined();
    expect(m.apply([t("borsch", "shahed")], T0 + 60_000)[0]!.type).toBe("shahed");
  });

  it("швидкий замір чи нема заміру — не чіпає; успадкований злиттям реактивний із повільним заміром — спростовано", () => {
    const m = new TypeMemory();
    const fast = { ...t("a", "reactive"), typeFromChannels: true, quality: q(390) };
    const none = { ...t("b", "reactive"), typeFromChannels: true, quality: q(null) };
    const own = { ...t("c", "reactive"), quality: q(120) };
    expect(refuteJetBySpeed([fast, none, own], m).map((x) => x.type)).toEqual([
      "reactive",
      "reactive",
      "shahed",
    ]);
  });
});

describe("refuteJetBySpeed — «Бандероль» і злиті звіти (04.11)", () => {
  const q = (speedKmh: number | null) => ({ ...EMPTY_QUALITY, speedKmh });
  it("«Бандероль» із заміряними 95 км/год — шахед; памʼять забуває і злиті id", () => {
    const m = new TypeMemory();
    m.note([t("old", "banderol")], T0);
    const [out] = refuteJetBySpeed(
      [{ ...t("head", "banderol"), quality: q(95), mergedIds: ["old"] }],
      m,
    );
    expect(out!.type).toBe("shahed");
    expect(m.apply([t("old", "shahed")], T0 + 60_000)[0]!.type).toBe("shahed");
  });
});
