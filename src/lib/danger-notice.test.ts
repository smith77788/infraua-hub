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

// Координати мають значення: модуль рахує цілі саме в області людини.
const SUMY = { lat: 50.91, lon: 34.8 };
const RIVNE = { lat: 50.62, lon: 26.25 };
const ZHYTOMYR = { lat: 50.25, lon: 28.66 };

const threat = (type: ThreatType, at: { lat: number; lon: number } = SUMY): Threat =>
  ({
    id: "1",
    name: "x",
    lat: at.lat,
    lon: at.lon,
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

  it("дронова загроза з дроном у цій же області — застереження не потрібне", () => {
    // Інакше застереження лунало б завжди й перестало б щось означати.
    const n = dangerNotice(levels("yellow", DRONE), [threat("shahed")], "Сумська область");
    expect(n.level).toBe("watch");
    expect(n.blindTo).toBeNull();
    expect(n.hereCount).toBe(1);
  });

  it("ГОЛОВНЕ-2: оголошено, а цілей у цій області нуль — називає сліпоту МІСЦЯ", () => {
    /*
     * Удар по Рівному 19.10.2026, 11:40. Офіційно — дронова загроза, клас, який
     * фід ніби покриває. Місцевий канал вів ціль вулицями міста 16 хвилин. У
     * фіді в Рівненській області за весь цей час — нуль цілей; найближча була в
     * Житомирській.
     *
     * Доти перевірка класу проходила успішно і модуль не казав нічого: цілі ж
     * були. Просто не тут.
     */
    const n = dangerNotice(
      levels("yellow", DRONE, "Рівненська область"),
      [threat("reactive", ZHYTOMYR)],
      "Рівненщина",
    );
    expect(n.level).toBe("watch");
    expect(n.hereCount).toBe(0);
    expect(n.blindTo).not.toBeNull();
    expect(n.blindTo).toContain("НЕ означає, що тихо");
  });

  it("ціль у своїй області знімає застереження і за народною назвою", () => {
    // Якби ключ області не зводився до спільного, рахувалось би завжди нуль.
    const n = dangerNotice(
      levels("yellow", DRONE, "Рівненська область"),
      [threat("reactive", RIVNE)],
      "Рівненщина",
    );
    expect(n.hereCount).toBe(1);
    expect(n.blindTo).toBeNull();
  });

  it("без відомої області цілі тут не рахуємо — твердженню нема підмета", () => {
    const n = dangerNotice(levels("yellow", DRONE), [], null);
    expect(n.hereCount).toBeNull();
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
