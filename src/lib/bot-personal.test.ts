import { describe, expect, it } from "bun:test";

import { dangerIndex, personalAssessment } from "./advisory";
import type { Threat, ThreatType } from "./air";
import {
  locationKeyboard,
  parsePersonalAction,
  renderAlert,
  renderAskPoint,
  renderPersonal,
  renderSettings,
  settingsKeyboard,
} from "./bot-personal";
import { newSubscriber, type Subscriber } from "./subscribers";

const KYIV = { lat: 50.45, lon: 30.52 };

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

function sub(patch: Partial<Subscriber> = {}): Subscriber {
  return {
    ...newSubscriber(1, "2026-01-01T00:00:00Z"),
    point: { ...KYIV, label: "моя точка" },
    ...patch,
  };
}

function cards(threats: Threat[], radiusKm = 50) {
  const assess = personalAssessment(threats, KYIV, { radiusKm });
  return { assess, danger: dangerIndex(assess) };
}

describe("renderPersonal", () => {
  it("вхідна ціль близько — вердикт «в укриття» і хвилини", () => {
    const { assess, danger } = cards([inbound("a", "shahed", 12)]);
    const text = renderPersonal(assess, danger, "моя точка", 50);
    expect(text).toContain("В УКРИТТЯ");
    expect(text).toContain("іде на вас");
    expect(text).toContain("хв");
  });

  it("порожнє небо — спокій і названий радіус", () => {
    const { assess, danger } = cards([]);
    const text = renderPersonal(assess, danger, "моя точка", 50);
    expect(text).toContain("Спокійно");
    expect(text).toContain("У радіусі 50 км нічого не бачимо");
  });

  it("число завжди йде зі своєю межею — це не радар", () => {
    const { assess, danger } = cards([inbound("a", "shahed", 12)]);
    expect(renderPersonal(assess, danger, "моя точка", 50)).toContain("OSINT");
  });

  it("назва точки екранується — інакше «<» ламає повідомлення", () => {
    const { assess, danger } = cards([]);
    expect(renderPersonal(assess, danger, "дім <b>", 50)).toContain("&lt;b&gt;");
  });
});

describe("renderAlert", () => {
  it("веде головним: що робити, чим і за скільки", () => {
    const { assess, danger } = cards([inbound("a", "ballistic", 30)]);
    const text = renderAlert(assess, danger, "моя точка");
    expect(text.split("\n")[0]).toContain("УКРИТТЯ");
    expect(text).toContain("балістика");
    expect(text).toContain("Повітряні Сили");
  });

  it("кілька вхідних — сказано скільки", () => {
    const { assess, danger } = cards([inbound("a", "shahed", 20), inbound("b", "shahed", 25)]);
    expect(renderAlert(assess, danger, "моя точка")).toContain("Усього на вашу точку: 2");
  });
});

describe("налаштування", () => {
  it("показують усі чотири ручки", () => {
    const text = renderSettings(sub());
    expect(text).toContain("Точка");
    expect(text).toContain("Радіус");
    expect(text).toContain("Будити");
    expect(text).toContain("Уночі");
  });

  it("без точки так і сказано, а не показано порожнє місце", () => {
    expect(renderSettings(sub({ point: null }))).toContain("не задана");
  });

  it("поточний вибір позначений галочкою", () => {
    const kb = settingsKeyboard(sub({ tier: "critical", radiusKm: 100 }));
    const flat = kb.inline_keyboard.flat();
    expect(flat.find((b) => b.callback_data === "t:critical")!.text).toContain("✅");
    expect(flat.find((b) => b.callback_data === "km:100")!.text).toContain("✅");
  });

  it("усі коди кнопок вкладаються в 64 байти Telegram", () => {
    for (const b of settingsKeyboard(sub()).inline_keyboard.flat()) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
  });
});

describe("parsePersonalAction", () => {
  it("розбирає свої кнопки", () => {
    expect(parsePersonalAction("pv")).toEqual({ kind: "refresh" });
    expect(parsePersonalAction("t:all")).toEqual({ kind: "tier", value: "all" });
    expect(parsePersonalAction("n:silent")).toEqual({ kind: "night", value: "silent" });
    expect(parsePersonalAction("km:25")).toEqual({ kind: "radius", value: 25 });
    expect(parsePersonalAction("mu:1")).toEqual({ kind: "mute", value: true });
  });

  it("чужі кнопки віддає далі, а не ковтає", () => {
    // Адмінські коди мають дійти до своєї гілки — інакше панель власника
    // перестане реагувати, щойно зʼявився другий набір кнопок.
    expect(parsePersonalAction("l:on")).toBeNull();
    expect(parsePersonalAction("p:go")).toBeNull();
    expect(parsePersonalAction("t:щось")).toBeNull();
  });
});

describe("прохання точки", () => {
  it("каже, що робиться з координатами", () => {
    expect(renderAskPoint()).toContain("лише для розрахунку відстані");
  });
  it("кнопка геолокації є в приватному чаті й відсутня в групі", () => {
    expect(locationKeyboard("private")).toBeDefined();
    expect(locationKeyboard("supergroup")).toBeUndefined();
  });
});
