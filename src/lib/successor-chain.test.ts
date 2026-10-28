import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { mapNeptunThreat, type NeptunThreat } from "./neptun-map";
import { couldBeSame, mergeSuccessorChains, QUIET_MS } from "./successor-chain";

/*
 * Дослівний зріз neptun.in.ua/api/v1/threats, 28.10.2026 18:13:13 UTC — саме
 * тоді користувач надіслав знімок «Нептун показує одну ціль, а ми багато».
 * Чотири треки біля Житомира, усі `status: active`.
 */
const ZHYTOMYR = [
  {
    id: "trk_00307999",
    type: "uav",
    title: "БпЛА",
    region: "Житомирська область",
    district: "",
    locality: "Коростишів",
    lat: 50.37814801484261,
    lon: 29.160876883048555,
    heading: 227.079,
    confidenceLevel: "medium",
    sourceCount: 4,
    updatedAt: "2026-10-28T18:06:27Z",
    status: "active",
    confirmedAt: "2026-10-28T18:06:27Z",
    uncertaintyKm: 4,
    positionQuality: "approx",
    lifecycle: "uncertain",
    displayConfidence: "medium",
    destination: true,
    presumptiveCourse: true,
  },
  {
    id: "trk_00308004",
    type: "uav",
    title: "БпЛА",
    region: "Житомирська область",
    district: "",
    locality: "Житомир",
    lat: 50.2547,
    lon: 28.6587,
    heading: null,
    confidenceLevel: "high",
    sourceCount: 6,
    updatedAt: "2026-10-28T18:08:41Z",
    status: "active",
    confirmedAt: "2026-10-28T18:08:41Z",
    uncertaintyKm: 4,
    positionQuality: "confirmed",
    lifecycle: "confirmed",
    displayConfidence: "high",
  },
  {
    id: "trk_00308008",
    type: "uav",
    title: "БпЛА",
    region: "Житомирська область",
    district: "",
    locality: "Оліївка",
    lat: 50.40054464256597,
    lon: 28.795646379153567,
    heading: 231.084,
    confidenceLevel: "medium",
    sourceCount: 2,
    updatedAt: "2026-10-28T18:06:51Z",
    status: "active",
    confirmedAt: "2026-10-28T18:06:51Z",
    uncertaintyKm: 10,
    positionQuality: "approx",
    lifecycle: "uncertain",
    displayConfidence: "medium",
    destination: true,
    presumptiveCourse: true,
  },
  {
    id: "trk_00308013",
    type: "uav",
    title: "БпЛА",
    region: "Житомирська область",
    district: "",
    locality: "Пулини",
    lat: 50.517680570705615,
    lon: 28.387257725677582,
    heading: 236.09,
    confidenceLevel: "medium",
    sourceCount: 3,
    updatedAt: "2026-10-28T18:11:13Z",
    status: "active",
    confirmedAt: "2026-10-28T18:11:13Z",
    uncertaintyKm: 4,
    positionQuality: "approx",
    lifecycle: "uncertain",
    displayConfidence: "medium",
    destination: true,
    presumptiveCourse: true,
  },
] as unknown as NeptunThreat[];

/** Так їх бачила консоль: канали назвали дрон реактивним (jet-sightings). */
const asReactive = (): Threat[] =>
  ZHYTOMYR.map((t) => mapNeptunThreat(t)!).map((t) => ({ ...t, type: "reactive" as const }));

describe("ланцюжок наступників — дослівний зріз біля Житомира", () => {
  it("чотири звіти стають трьома цілями — стільки, скільки дозволяє фізика", () => {
    /*
     * Коростишів (18:06:27) і Оліївка (18:06:51) — 26 км за 24 с: один дрон так
     * не літає. Житомир → Пулини — 36 км за 152 с, тобто ≈ 840 км/год між
     * центрами і понад 650 навіть із похибками; реактивний — до 600. Тож і це
     * два різні апарати (або хибний звіт), і сховати один ми не маємо права.
     * Злито лише Оліївку з Житомиром: 19 км за 110 с — шлях одного дрона.
     */
    const out = mergeSuccessorChains(asReactive());
    expect(out.map((t) => t.name).sort()).toEqual(["Житомир", "Коростишів", "Пулини"]);
  });

  it("голова ланцюжка несе шлях: Оліївка → Житомир", () => {
    const head = mergeSuccessorChains(asReactive()).find((t) => t.name === "Житомир")!;
    expect(head.trail!.map((p) => [p.lat.toFixed(2), p.lon.toFixed(2)])).toEqual([
      ["50.40", "28.80"],
      ["50.25", "28.66"],
    ]);
  });

  it("один апарат — лічильник один, а не сума звітів", () => {
    const head = mergeSuccessorChains(asReactive()).find((t) => t.name === "Житомир")!;
    expect(head.count).toBe(1);
  });

  it("поршневі шахеди: та сама пара в межах невизначеності, інші — окремо", () => {
    // Оліївка (±10 км) і Житомир (±4 км) за 19 км — у межах похибок навіть для
    // повільного дрона; Житомир → Пулини для поршневого (≤ 278 км/год) — ні.
    const plain = ZHYTOMYR.map((t) => mapNeptunThreat(t)!);
    expect(plain.every((t) => t.type === "shahed")).toBe(true);
    const out = mergeSuccessorChains(plain);
    expect(out.map((t) => t.name).sort()).toEqual(["Житомир", "Коростишів", "Пулини"]);
  });

  it("злиття, яке вимагало б понад 600 км/год, не відбувається", () => {
    // Живий випадок 28.10: «Синельникове → Розумівка», 61 км за 249 с.
    const a = {
      ...asReactive()[0]!,
      id: "s",
      name: "Синельникове",
      lat: 48.32,
      lon: 35.52,
      lastSeen: "2026-10-28T18:30:00Z",
      since: "2026-10-28T18:30:00Z",
    };
    const b = {
      ...asReactive()[0]!,
      id: "r",
      name: "Розумівка",
      lat: 47.79,
      lon: 35.37,
      lastSeen: "2026-10-28T18:34:09Z",
      since: "2026-10-28T18:34:09Z",
    };
    expect(couldBeSame(a, b)).toBe(false);
  });
});

describe("couldBeSame — межі правила", () => {
  const base = (over: Partial<Threat>): Threat => ({
    id: "x",
    name: "x",
    lat: 50,
    lon: 30,
    source: "neptun.in.ua",
    count: 1,
    since: "2026-10-28T18:00:00Z",
    lastSeen: "2026-10-28T18:00:00Z",
    expires: "",
    type: "reactive",
    ...over,
  });

  it("паралельні дрони, оновлені майже одночасно, не зливаються", () => {
    const a = base({ id: "a" });
    const b = base({
      id: "b",
      lat: 50.05,
      lastSeen: new Date(Date.parse("2026-10-28T18:00:00Z") + QUIET_MS - 1_000).toISOString(),
    });
    expect(couldBeSame(a, b)).toBe(false);
  });

  it("ракету з дроном не зливаємо ніколи", () => {
    const a = base({ id: "a" });
    const b = base({ id: "b", type: "cruise", lastSeen: "2026-10-28T18:03:00Z" });
    expect(couldBeSame(a, b)).toBe(false);
  });

  it("надто давній попередник — уже не той самий відрізок польоту", () => {
    const a = base({ id: "a" });
    const b = base({ id: "b", lat: 50.01, lastSeen: "2026-10-28T18:20:00Z" });
    expect(couldBeSame(a, b)).toBe(false);
  });

  it("ракети й поодинокі цілі проходять крізь злиття без змін", () => {
    const kab = base({ id: "k", type: "kab" });
    expect(mergeSuccessorChains([kab])).toEqual([kab]);
  });
});
