import { describe, expect, it } from "bun:test";

import {
  fuseThreats,
  normalizeThreatType,
  observationsTooOldForAlerts,
  observedAt,
  type Threat,
  readCount,
  finiteOr,
} from "./air";
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

describe("observedAt — коли ціль справді спостерегли", () => {
  const t = (over: Partial<Threat>): Threat =>
    ({
      id: "1",
      name: "x",
      lat: 50,
      lon: 30,
      source: "s",
      count: 1,
      since: "",
      expires: "",
      ...over,
    }) as Threat;

  it("бере найсвіжішу мітку з усіх цілей", () => {
    const at = observedAt([
      t({ lastSeen: "2026-09-16T18:50:00Z" }),
      t({ lastSeen: "2026-09-16T18:56:00Z" }),
      t({ lastSeen: "2026-09-16T18:52:00Z" }),
    ]);
    expect(at).toBe(Date.parse("2026-09-16T18:56:00Z"));
  });

  it("без lastSeen бере since", () => {
    expect(observedAt([t({ since: "2026-09-16T18:40:00Z" })])).toBe(
      Date.parse("2026-09-16T18:40:00Z"),
    );
  });

  it("порожнє небо не має віку спостереження", () => {
    /*
     * Не «дуже старо»: інакше кожна тиха ніч читалась би як поломка фіду — а
     * це найшвидший спосіб навчити людей не вірити банеру.
     */
    expect(observedAt([])).toBeNull();
  });

  it("биті мітки не вважаються спостереженням", () => {
    expect(observedAt([t({ lastSeen: "не дата" }), t({ since: "" })])).toBeNull();
  });
});

describe("observationsTooOldForAlerts — кого можна будити", () => {
  const NOW = Date.UTC(2026, 8, 16, 19, 0, 0);
  const at = (minAgo: number) =>
    ({
      id: "1",
      name: "x",
      lat: 50,
      lon: 30,
      source: "s",
      count: 1,
      since: "",
      expires: "",
      lastSeen: new Date(NOW - minAgo * 60_000).toISOString(),
    }) as Threat;

  it("свіже спостереження — будимо", () => {
    expect(observationsTooOldForAlerts([at(2)], NOW)).toBe(false);
  });

  it("годинна позиція — не будимо", () => {
    /*
     * Шахед за годину пролітає близько 180 км. «В укриття» за такою позицією —
     * або зайва паніка, або обіцянка прикриття, якого немає.
     */
    expect(observationsTooOldForAlerts([at(60)], NOW)).toBe(true);
  });

  it("порожнє небо застарим не буває", () => {
    // Інакше радар вимикався б щотихої ночі.
    expect(observationsTooOldForAlerts([], NOW)).toBe(false);
  });

  it("цілі є, а часу спостереження немає — не заважаємо", () => {
    // Судити нема на чому; мовчазно вимикати сповіщення гірше.
    const noTime = { ...at(1), lastSeen: "", since: "" } as Threat;
    expect(observationsTooOldForAlerts([noTime], NOW)).toBe(false);
  });

  it("межа рахується за НАЙСВІЖІШОЮ ціллю, а не за найстарішою", () => {
    // Одна стара позначка поруч зі свіжими не має глушити весь радар.
    expect(observationsTooOldForAlerts([at(90), at(1)], NOW)).toBe(false);
  });
});

describe("readCount — чужий лічильник у число, якому можна вірити", () => {
  it("Infinity із JSON не стає кількістю цілей", () => {
    // У JSON немає літерала NaN, але JSON.parse("1e400") дає Infinity — цілком
    // законне число з погляду формату. Далі воно текло сумою в знімок, звідти в
    // пік хвилі, і в канал ішов рядок «всього в небі: Infinity».
    expect(readCount(JSON.parse("1e400") as number)).toBe(1);
    expect(readCount(Infinity)).toBe(1);
    expect(readCount(-Infinity)).toBe(1);
    expect(readCount(Number.NaN)).toBe(1);
  });

  it("відсутнє або чуже за типом — одна ціль", () => {
    expect(readCount(undefined)).toBe(1);
    expect(readCount(null)).toBe(1);
    expect(readCount("5")).toBe(1);
  });

  it("нуль і відʼємне — одна ціль, а не нуль цілей", () => {
    // Позначка існує, отже ціль щонайменше одна: нуль тут означав би, що
    // джерело повідомило про ніщо.
    expect(readCount(0)).toBe(1);
    expect(readCount(-7)).toBe(1);
  });

  it("дробове округлюється донизу, справжні числа проходять", () => {
    expect(readCount(3)).toBe(3);
    expect(readCount(3.9)).toBe(3);
  });

  it("верхньої стелі немає навмисно", () => {
    // Вигадана межа мовчки обрізала б справжній масований наліт, а це гірше за
    // велике число.
    expect(readCount(500)).toBe(500);
    expect(readCount(100_000)).toBe(100_000);
  });
});

describe("finiteOr — величини, які бувають відʼємними й дробовими", () => {
  it("Infinity не переживає читання", () => {
    // `typeof Infinity === "number"` істинне, і `Math.round(Infinity)` теж
    // Infinity — тому перевірки типу тут не досить.
    expect(finiteOr(JSON.parse("1e400") as number, 0)).toBe(0);
    expect(finiteOr(-Infinity, 0)).toBe(0);
    expect(finiteOr(Number.NaN, 0)).toBe(0);
  });

  it("справжні величини проходять, зокрема відʼємні й дробові", () => {
    expect(finiteOr(-12.5, 0)).toBe(-12.5);
    expect(finiteOr(0, 7)).toBe(0);
  });

  it("чуже за типом і відсутнє — запасне значення", () => {
    expect(finiteOr("-5", 0)).toBe(0);
    expect(finiteOr(undefined, 3)).toBe(3);
    expect(finiteOr(null, 3)).toBe(3);
  });
});
