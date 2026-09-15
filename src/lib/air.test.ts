import { describe, expect, it } from "bun:test";

import { fuseThreats, normalizeThreatType, type Threat } from "./air";
import { renderChannelPost } from "./channel-post";

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

/*
 * Знайдено перебором граничних входів: невідомий тип цілі валив
 * `renderChannelPost` ЦІЛКОМ — тобто одна дивна ціль позбавляла поста весь
 * канал. Таблиці підстановки припускали, що ключ завжди свій, а це припущення
 * трималося на типізації, якої в рантаймі немає: типи приходять із мережі.
 */
describe("normalizeThreatType — тип із мережі зводиться до відомого", () => {
  it("відомі типи лишаються собою", () => {
    for (const t of [
      "shahed",
      "reactive",
      "cruise",
      "missile",
      "ballistic",
      "kab",
      "recon",
      "aircraft",
      "unknown",
    ]) {
      expect(normalizeThreatType(t)).toBe(t as never);
    }
  });

  it("невідомий рядок стає unknown, а не валить пост", () => {
    expect(normalizeThreatType("не-тип")).toBe("unknown");
    expect(normalizeThreatType("SHAHED")).toBe("unknown");
    expect(normalizeThreatType("")).toBe("unknown");
  });

  it("не-рядок теж стає unknown", () => {
    expect(normalizeThreatType(undefined)).toBe("unknown");
    expect(normalizeThreatType(null)).toBe("unknown");
    expect(normalizeThreatType(7)).toBe("unknown");
    expect(normalizeThreatType({})).toBe("unknown");
  });

  it("пост із невідомим типом будується, а не кидає виняток", () => {
    const t = {
      id: "x",
      name: "",
      lat: 50.45,
      lon: 30.52,
      source: "s",
      count: 1,
      since: "",
      expires: "",
      type: "не-тип" as never,
    };
    expect(() => renderChannelPost([t])).not.toThrow();
    expect(renderChannelPost([t])).not.toBeNull();
  });
});
