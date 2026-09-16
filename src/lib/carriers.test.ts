import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import {
  CARRIER_WARNING_TTL_MS,
  detectCarrier,
  renderCarrierWarning,
  warningIsFresh,
} from "./carriers";

function threat(name: string, type: Threat["type"] = "aircraft"): Threat {
  return {
    id: Math.random().toString(36).slice(2),
    name,
    lat: 50,
    lon: 30,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    type,
    reports: 2,
  };
}

describe("detectCarrier", () => {
  it("МіГ-31К — це те попередження, заради якого все", () => {
    expect(detectCarrier([threat("Зліт МіГ-31К з аеродрому")], 1000)).not.toBeNull();
  });

  it("Ту-95 і Кинджал теж носії", () => {
    expect(detectCarrier([threat("Ту-95 у повітрі")], 1000)).not.toBeNull();
    expect(detectCarrier([threat("загроза Кинджалів")], 1000)).not.toBeNull();
  });

  it("звичайна тактична авіація попередженням не стає", () => {
    // Інакше «готовність по країні» лунала б щодня — і знецінилась би рівно
    // до того, як знадобиться.
    expect(detectCarrier([threat("тактична авіація в повітрі")], 1000)).toBeNull();
  });

  it("шахед із назвою «міг» у тексті не вважається носієм", () => {
    // Клас перевіряється окремо від слів: тип має бути саме aircraft.
    expect(detectCarrier([threat("МіГ-31К", "shahed")], 1000)).toBeNull();
  });

  it("порожнє небо — порожньо", () => {
    expect(detectCarrier([], 1000)).toBeNull();
  });

  it("рахує, скільки джерел сказали те саме", () => {
    const w = detectCarrier([threat("МіГ-31К"), threat("МіГ-31К")], 1000)!;
    expect(w.reports).toBe(4);
  });
});

describe("warningIsFresh", () => {
  it("попередження застаріває — літак міг сісти", () => {
    const w = { what: "МіГ-31К", at: 0, reports: 2 };
    expect(warningIsFresh(w, CARRIER_WARNING_TTL_MS - 1)).toBe(true);
    expect(warningIsFresh(w, CARRIER_WARNING_TTL_MS + 1)).toBe(false);
    expect(warningIsFresh(null, 0)).toBe(false);
  });
});

describe("renderCarrierWarning", () => {
  it("прямо каже, що пуску ще НЕ БУЛО", () => {
    // Людина, що прочитає «летить ракета» і побіжить в укриття на годину,
    // наступного разу не побіжить узагалі.
    const text = renderCarrierWarning({ what: "МіГ-31К", at: 0, reports: 3 });
    expect(text).toContain("Пуску ще НЕ БУЛО");
    expect(text).toContain("готовність");
    expect(text).not.toContain("летить ракета");
  });
});
