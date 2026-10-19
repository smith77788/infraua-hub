import { describe, expect, it } from "bun:test";

import { classOfReason, dangerNotice } from "./danger-notice";
import { parseAlertLevels, type AlertLevels } from "./alert-levels";
import type { Threat, ThreatType } from "./air";

const levels = (level: string, reason: string, oblast = "Сумська область"): AlertLevels =>
  parseAlertLevels({
    raions: [{ key: "k", name: "Район", oblast, level, since: "", reasons: [reason] }],
    oblasts: [],
    updatedAt: "",
  })!;

const threat = (type: ThreatType): Threat =>
  ({
    id: "1",
    name: "x",
    lat: 50,
    lon: 30,
    source: "s",
    count: 1,
    since: "",
    expires: "",
    type,
  }) as Threat;

const MISSILE = "Ракетна загроза (червоний рівень)";
const DRONE = "Дронова загроза (жовтий рівень)";

describe("classOfReason", () => {
  it("розпізнає ракетний клас у реальних формулюваннях джерела", () => {
    expect(classOfReason(MISSILE)).toBe("missile");
    expect(classOfReason("Балістична загроза")).toBe("missile");
    expect(classOfReason("Загроза застосування КАБ")).toBe("missile");
  });

  it("розпізнає дрони", () => {
    expect(classOfReason(DRONE)).toBe("drone");
  });

  it("незнайоме формулювання лишається «інше», а не вгадується", () => {
    // Вигадати клас небезпечніше, ніж визнати, що не розпізнали.
    expect(classOfReason("Щось геть нове")).toBe("other");
  });
});

describe("dangerNotice", () => {
  it("мовчить, коли нічого не оголошено", () => {
    expect(dangerNotice(parseAlertLevels({ raions: [], oblasts: [] }), [], null).level).toBe(
      "none",
    );
  });

  it("мовчить, коли рівнів узагалі немає", () => {
    // Джерело не відповіло — це не привід стверджувати про небезпеку чи спокій.
    expect(dangerNotice(null, [], null).level).toBe("none");
  });

  it("червоний рівень — це «небезпека», а не просто колір на карті", () => {
    const n = dangerNotice(levels("red", MISSILE), [], "Сумська область");
    expect(n.level).toBe("danger");
    expect(n.headline).toContain("Сумська область");
    expect(n.reasons).toContain(MISSILE);
  });

  it("ГОЛОВНЕ: ракетна небезпека без ракетних цілей — називає сліпоту", () => {
    /*
     * Саме цей випадок і стався: офіційно ракетна загроза, на карті лише дрони
     * (або порожньо), і людина читає це як «тихо». Заміряно на живих даних:
     * 23 райони з ракетною загрозою, 0 ракетних цілей у фіді.
     */
    const n = dangerNotice(levels("red", MISSILE), [threat("shahed")], "Сумська область");
    expect(n.blindTo).not.toBeNull();
    expect(n.blindTo).toContain("НЕ означає, що тихо");
  });

  it("порожній фід під ракетною загрозою — так само називає сліпоту", () => {
    expect(dangerNotice(levels("red", MISSILE), [], "Сумська область").blindTo).not.toBeNull();
  });

  it("коли ракетні цілі В НАС Є — про сліпоту не кажемо", () => {
    // Інакше застереження лунало б завжди й перестало б щось означати.
    const n = dangerNotice(levels("red", MISSILE), [threat("ballistic")], "Сумська область");
    expect(n.blindTo).toBeNull();
  });

  it("дронова загроза не тягне застереження: цей клас фід покриває", () => {
    const n = dangerNotice(levels("yellow", DRONE), [], "Сумська область");
    expect(n.level).toBe("watch");
    expect(n.blindTo).toBeNull();
  });

  it("без відомої області дивимось на всю країну", () => {
    // Краще сказати про ракетну небезпеку в сусідній області, ніж промовчати.
    const n = dangerNotice(levels("red", MISSILE, "Харківська область"), [], null);
    expect(n.level).toBe("danger");
  });

  it("червоний переважає жовтий", () => {
    const both = parseAlertLevels({
      raions: [
        {
          key: "a",
          name: "A",
          oblast: "Сумська область",
          level: "yellow",
          since: "",
          reasons: [DRONE],
        },
        {
          key: "b",
          name: "B",
          oblast: "Сумська область",
          level: "red",
          since: "",
          reasons: [MISSILE],
        },
      ],
      oblasts: [],
    })!;
    expect(dangerNotice(both, [], "Сумська область").level).toBe("danger");
  });
});
