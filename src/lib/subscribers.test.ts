import { describe, expect, it } from "bun:test";

import { dangerIndex, personalAssessment } from "./advisory";
import type { Threat, ThreatType } from "./air";
import {
  ALERT_COOLDOWN_MS,
  ALERT_FLOOR_MS,
  clampRadius,
  decideAlert,
  forgetStale,
  isNight,
  markAlerted,
  newSubscriber,
  parseNight,
  parseTier,
  refCode,
  type Subscriber,
} from "./subscribers";

const KYIV = { lat: 50.45, lon: 30.52 };

/** Ціль на південь від точки, курсом рівно на північ — тобто просто на неї. */
function inbound(id: string, type: ThreatType, kmSouth: number): Threat {
  return {
    id,
    name: "Ціль",
    lat: KYIV.lat - kmSouth / 111,
    lon: KYIV.lon,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    type,
    heading: 0,
  };
}

/** Ціль поруч, але курсом ГЕТЬ від точки. */
function outbound(id: string, kmSouth: number): Threat {
  return { ...inbound(id, "shahed", kmSouth), heading: 180 };
}

function sub(patch: Partial<Subscriber> = {}): Subscriber {
  return {
    ...newSubscriber(777, "2026-01-01T00:00:00Z"),
    point: { ...KYIV, label: "моя точка" },
    ...patch,
  };
}

function decide(s: Subscriber, threats: Threat[], now = 1_000_000, hour = 12) {
  const assess = personalAssessment(threats, s.point!, { radiusKm: s.radiusKm });
  return decideAlert(s, assess, dangerIndex(assess), now, hour);
}

describe("refCode", () => {
  it("стабільний для того самого chatId", () => {
    expect(refCode(12345)).toBe(refCode(12345));
  });
  it("різні chatId — різні коди", () => {
    expect(refCode(12345)).not.toBe(refCode(12346));
  });
  it("не містить самого chatId — інакше посилання видавало б Telegram-id", () => {
    expect(refCode(12345)).not.toContain("12345");
  });
});

describe("isNight", () => {
  it("23:00 і 03:00 — ніч, 08:00 і 22:00 — ні", () => {
    expect(isNight(23)).toBe(true);
    expect(isNight(3)).toBe(true);
    expect(isNight(8)).toBe(false);
    expect(isNight(22)).toBe(false);
  });
});

describe("decideAlert", () => {
  it("нічого не йде на точку — мовчимо", () => {
    const d = decide(sub(), [outbound("a", 30)]);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("нічого не йде");
  });

  it("вхідна ціль у радіусі — будимо", () => {
    const d = decide(sub(), [inbound("a", "shahed", 40)]);
    expect(d.send).toBe(true);
    expect(d.ids).toEqual(["a"]);
  });

  it("вхідна ціль ДАЛІ за радіус — мовчимо", () => {
    const d = decide(sub({ radiusKm: 25 }), [inbound("a", "shahed", 90)]);
    expect(d.send).toBe(false);
  });

  it("поріг «лише критичне» пропускає ракету і не пропускає шахед", () => {
    expect(decide(sub({ tier: "critical" }), [inbound("a", "shahed", 40)]).send).toBe(false);
    expect(decide(sub({ tier: "critical" }), [inbound("b", "ballistic", 40)]).send).toBe(true);
  });

  it("нічна тиша не будить навіть балістикою", () => {
    const d = decide(sub({ night: "silent" }), [inbound("a", "ballistic", 40)], 1_000_000, 2);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("тиша");
  });

  it("нічний режим «критичне» глушить шахед, але не ракету", () => {
    expect(decide(sub(), [inbound("a", "shahed", 40)], 1_000_000, 2).send).toBe(false);
    expect(decide(sub(), [inbound("b", "cruise", 40)], 1_000_000, 2).send).toBe(true);
  });

  it("нічний режим не РОЗШИРЮЄ денний: «лише критичне» вдень лишається таким і вночі", () => {
    const s = sub({ tier: "critical", night: "all" });
    expect(decide(s, [inbound("a", "shahed", 40)], 1_000_000, 2).send).toBe(false);
  });

  it("про ту саму ціль удруге не пишемо, поки триває пауза", () => {
    const threats = [inbound("a", "shahed", 40)];
    const first = decide(sub(), threats);
    const after = markAlerted(sub(), first, 1_000_000);
    // Одразу після надсилання спрацьовує жорстка підлога…
    expect(decide(after, threats, 1_000_000 + 60_000).reason).toContain("щойно надсилали");
    // …а далі, вже за підлогою, мовчить саме дедуп за цілями.
    const second = decide(after, threats, 1_000_000 + 5 * 60_000);
    expect(second.send).toBe(false);
    expect(second.reason).toContain("щойно повідомили");
  });

  it("нова ціль пробиває паузу — але не раніше за жорстку підлогу", () => {
    const after = markAlerted(sub(), decide(sub(), [inbound("a", "shahed", 40)]), 1_000_000);
    const threats = [inbound("a", "shahed", 40), inbound("b", "shahed", 45)];
    // Через хвилину — ще зарано: якщо джерело перестворило трек з новим id,
    // це було б друге сповіщення про ту саму ціль.
    expect(decide(after, threats, 1_000_000 + 60_000).send).toBe(false);
    expect(decide(after, threats, 1_000_000 + ALERT_FLOOR_MS + 1_000).send).toBe(true);
  });

  it("ескалація типу пробиває паузу навіть без нових ідентифікаторів", () => {
    // Та сама ціль «a», але тепер вона визначена як балістика й підійшла ближче:
    // рівень небезпеки виріс, і мовчати тут — гірше за зайве повідомлення.
    const first = decide(sub(), [inbound("a", "shahed", 120)]);
    const after = markAlerted(sub(), first, 1_000_000);
    const second = decide(after, [inbound("a", "ballistic", 20)], 1_000_000 + 10_000);
    expect(second.send).toBe(true);
    expect(second.reason).toContain("загострилась");
  });

  it("пауза на паузі — жодних сповіщень", () => {
    expect(decide(sub({ muted: true }), [inbound("a", "ballistic", 10)]).send).toBe(false);
  });

  it("без точки рішення не ухвалюється", () => {
    expect(decide(sub({ point: null }), []).send).toBe(false);
  });
});

describe("forgetStale", () => {
  it("після довгої тиші історія стирається — друга хвиля знову нова", () => {
    const s = sub({ lastAlertAt: 1_000, lastAlertIds: ["a"], lastLevel: "attention" });
    expect(forgetStale(s, 1_000 + ALERT_COOLDOWN_MS).lastAlertIds).toEqual(["a"]);
    expect(forgetStale(s, 1_000 + 60 * 60 * 1000).lastAlertIds).toEqual([]);
  });
});

describe("розбір налаштувань", () => {
  it("невідоме значення не перетворюється на усталене", () => {
    expect(parseTier("critical")).toBe("critical");
    expect(parseTier("щось")).toBeNull();
    expect(parseNight("silent")).toBe("silent");
    expect(parseNight("")).toBeNull();
  });
  it("радіус затискається в межі, а не відхиляється", () => {
    expect(clampRadius(1)).toBe(10);
    expect(clampRadius(9999)).toBe(200);
    expect(clampRadius(Number.NaN)).toBe(50);
  });
});
