import { describe, expect, it } from "bun:test";

import { summarize, type CategoryId, type Facility, type InfraEvent } from "./infra-types";

function facility(id: string, category: CategoryId): Facility {
  return { id, name: id, category, lat: 50, lon: 30, source: "test" };
}

function event(id: string): InfraEvent {
  return {
    id,
    title: id,
    kind: "fire",
    lat: 50,
    lon: 30,
    time: "2026-09-10T00:00:00Z",
    source: "test",
  };
}

function risk(ids: string[], e: InfraEvent): Map<string, InfraEvent> {
  return new Map(ids.map((id) => [id, e]));
}

/*
 * Рівень — це стан обʼєктів, а не факт тривоги. Тести тримають саме цю
 * межу: раніше `alarms > 0` сам по собі давав «критичний стан», тож найвищий
 * рівень горів щодня поруч із «під загрозою 0, подій немає».
 */
describe("summarize — від чого залежить рівень", () => {
  const facilities = [facility("h", "hospital"), facility("s", "substation")];
  const e = event("fire-1");

  it("тривога без наших обʼєктів у ній не піднімає рівень", () => {
    const s = summarize(facilities, new Map(), [], 5, 0);
    expect(s.level).toBe("normal");
    expect(s.alarms).toBe(5);
    expect(s.underAlarm).toBe(0);
  });

  it("тривога, що накрила обʼєкти, дає підвищену готовність", () => {
    const s = summarize(facilities, new Map(), [], 1, 2);
    expect(s.level).toBe("elevated");
    expect(s.underAlarm).toBe(2);
  });

  it("обʼєкти під подією дають підвищену готовність навіть без тривог", () => {
    const s = summarize(facilities, risk(["s"], e), [e], 0, 0);
    expect(s.level).toBe("elevated");
    expect(s.atRisk).toBe(1);
  });

  it("удар по життєзабезпеченню — критичний стан", () => {
    const s = summarize(facilities, risk(["h"], e), [e], 0, 0);
    expect(s.level).toBe("critical");
    expect(s.lifeAtRisk).toBe(1);
  });

  it("масштаб теж робить стан критичним", () => {
    const many = Array.from({ length: 10 }, (_, i) => facility(`s${i}`, "substation"));
    const s = summarize(
      many,
      risk(
        many.map((f) => f.id),
        e,
      ),
      [e],
      0,
      0,
    );
    expect(s.lifeAtRisk).toBe(0);
    expect(s.level).toBe("critical");
  });

  it("порожня картина лишається штатною", () => {
    const s = summarize(facilities, new Map(), [], 0, 0);
    expect(s.level).toBe("normal");
    expect(s.eventCount).toBe(0);
  });
});
