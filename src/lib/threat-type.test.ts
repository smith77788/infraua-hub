import { describe, expect, it } from "bun:test";

import { classifyThreatType, moreSevereType } from "./air";
import { mapNeptunType } from "./neptun-map";

describe("classifyThreatType", () => {
  it("розрізняє типи з тексту OSINT-повідомлень", () => {
    expect(classifyThreatType("🏍 Реактивний БпЛА у напрямку Чорноморськ")).toBe("reactive");
    expect(classifyThreatType("🛵 ударний БпЛА на Чернігівщині курсом на Мену")).toBe("shahed");
    expect(classifyThreatType("Загроза застосування балістики зі сходу")).toBe("ballistic");
    expect(classifyThreatType("Пуск крилатих ракет, Кинджал контроль")).toBe("ballistic"); // балістика раніша
    expect(classifyThreatType("Крилата ракета курсом на Київ")).toBe("cruise");
    expect(classifyThreatType("Загроза КАБів по прифронтових районах")).toBe("kab");
    expect(classifyThreatType("Ракетна небезпека! С-300 по Харкову")).toBe("missile");
    expect(classifyThreatType("Розвідувальний БпЛА Орлан над морем")).toBe("recon");
    expect(classifyThreatType("Спокійна ситуація, чисте небо")).toBe("unknown");
  });

  it("moreSevereType обирає важчий тип", () => {
    expect(moreSevereType("shahed", "missile")).toBe("missile");
    expect(moreSevereType("ballistic", "shahed")).toBe("ballistic");
    expect(moreSevereType("unknown", "reactive")).toBe("reactive");
    expect(moreSevereType("cruise", "unknown")).toBe("cruise");
  });
});

describe("реактивні й «Бандероль»: розмовні назви, «Герань-3» (дослівні дописи 22.10.2026)", () => {
  const JET = [
    "Вінниця - 1 реактив наближається до міста, увага!", // totallzrada
    "2 реактиви над Полтавою!", // totallzrada
    "Ізяслав - увага, наближення реактива до міста!", // totallzrada
    "8 реактивів на Рівненщину або Хмельниччину через Житомирщину", // totallzrada
    "Рівне уважно до вас реакт спускається з північної частини області", // zahidnimonitoring
    "РеактБпЛА курсом на Вінницю з півдня.", // monitor_ukr
    "Имеем 2х Реакт БпЛа на Дерезуватое курс Пещянка/Самар", // dnepr_nagladach
    "2х Реактивтині БпЛА курсом на Берестин", // kharkivlife, з одруківкою
    "Пуск Герань-3 з Курська",
    "Shahed-238 курсом на Київ",
  ];
  for (const text of JET) {
    it(text, () => expect(classifyThreatType(text)).toBe("reactive"));
  }

  const BANDEROL = [
    "Бандероль курсом на Дніпро", // RadarDnepr
    "‼️ Бандеролі повз Запоріжжя в напрямку Дніпра.", // radar_raketaa
    "‼ Відмічено пуски крилатих ракет типу «Бандероль» з акваторії Азовського моря.",
    "❗️ Зафіксовано пуск ракет «Бандероль»", // temporis_odesa
    "Могут быть Бандероли ~15:50-16:20", // odessa_inform
    "❗️ Пуски бандеролей", // inform_odesa — «пуск» не робить її авіацією
  ];
  for (const text of BANDEROL) {
    it(`«Бандероль» — окремий тип: ${text}`, () =>
      expect(classifyThreatType(text)).toBe("banderol"));
  }

  it("підпис каналу «✙ Розвідка неба ✙» не робить реактивний розвідником", () => {
    expect(
      classifyThreatType(
        "Запорізька область: | Реактивний БпЛА курсом на Запоріжжя | ✙ Розвідка неба ✙ | ✙ Підтримати канал ✙",
      ),
    ).toBe("reactive");
    expect(classifyThreatType("Чернігівщина: 3х БпЛА курсом на Сновськ ✙ Розвідка неба ✙")).toBe(
      "shahed",
    );
    expect(classifyThreatType("Розвідувальний БпЛА «Орлан» над Сумами")).toBe("recon");
  });

  it("«пуск» — дієслово: названий апарат важливіший за «авіацію»", () => {
    expect(
      classifyThreatType("⚠️ Пуск Shahed-136/Герань-2 з району Шаталово (Смоленська область)."),
    ).toBe("shahed");
    expect(classifyThreatType("Зліт МіГ-31К")).toBe("aircraft");
  });

  it("не реактивні: «реактор», «реакція», реактивна артилерія", () => {
    expect(classifyThreatType("Запорізька АЕС: реактор №5 зупинено")).not.toBe("reactive");
    expect(classifyThreatType("Реакція ППО миттєва")).not.toBe("reactive");
    expect(classifyThreatType("Обстріл з реактивної артилерії по Херсону")).not.toBe("reactive");
    expect(classifyThreatType("Удар реактивними системами залпового вогню")).not.toBe("reactive");
  });
});

describe("mapNeptunType — підтипи Нептуна", () => {
  it("`jet` — реактивний БпЛА, а не авіація", () => {
    expect(mapNeptunType("jet", "")).toBe("reactive");
    expect(mapNeptunType("aircraft", "")).toBe("aircraft");
  });

  it("текст Нептуна з «Бандероль» — «Бандероль», хоч тип і «uav»", () => {
    expect(mapNeptunType("uav", "Бандероль курсом на Запоріжжя.")).toBe("banderol");
  });
});
