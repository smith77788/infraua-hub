import { describe, expect, it } from "bun:test";

import { classifyThreatType, moreSevereType } from "./air";

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
