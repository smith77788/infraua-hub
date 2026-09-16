import { describe, expect, it } from "bun:test";

import {
  GROUP_COOLDOWN_MS,
  GROUP_DEFAULT_RADIUS_KM,
  newGroupDuty,
  parseDutyArgs,
  renderDuty,
  renderDutyHelp,
  shouldNotifyGroup,
} from "./group-duty";

const duty = () =>
  newGroupDuty(-100, "Родина", { lat: 50, lon: 30, label: "Харків" }, 7, "2026-01-01T00:00:00Z");

describe("модель чергового", () => {
  it("радіус групи вужчий за персональний — ціна помилки множиться на людей", () => {
    expect(GROUP_DEFAULT_RADIUS_KM).toBeLessThan(50);
    expect(duty().radiusKm).toBe(GROUP_DEFAULT_RADIUS_KM);
  });

  it("усталений рівень — те, що йде на нас, а не будь-який рух", () => {
    expect(duty().level).toBe("inbound");
  });

  it("видно, хто ввімкнув — щоб було з кого питати", () => {
    expect(duty().enabledBy).toBe(7);
  });
});

describe("parseDutyArgs", () => {
  it("розбирає вимкнення, радіус і рівень", () => {
    expect(parseDutyArgs("off")).toEqual({ kind: "off" });
    expect(parseDutyArgs("радіус 40")).toEqual({ kind: "radius", km: 40 });
    expect(parseDutyArgs("рівень все")).toEqual({ kind: "level", level: "all" });
  });

  it("радіус затискається в межі, а не приймається будь-який", () => {
    expect(parseDutyArgs("радіус 999")).toEqual({ kind: "radius", km: 100 });
    expect(parseDutyArgs("радіус 1")).toEqual({ kind: "radius", km: 5 });
  });

  it("решта — це назва міста", () => {
    expect(parseDutyArgs("Кривий Ріг")).toEqual({ kind: "place", query: "Кривий Ріг" });
  });

  it("порожньо — показати довідку", () => {
    expect(parseDutyArgs("  ")).toBeNull();
  });

  it("сміття в числі не стає радіусом", () => {
    expect(parseDutyArgs("радіус багато")).toBeNull();
  });
});

describe("shouldNotifyGroup", () => {
  const t = (id: string, critical = false) => ({ id, critical });

  it("нові цілі будять чат", () => {
    expect(shouldNotifyGroup(duty(), [t("a")], 10_000_000).send).toBe(true);
  });

  it("ті самі цілі вдруге — ні", () => {
    const d = { ...duty(), lastAlertIds: ["a"], lastAlertAt: 1000 };
    expect(shouldNotifyGroup(d, [t("a")], 10_000_000).send).toBe(false);
  });

  it("пауза для групи довша: двадцять перерваних справ дорожчі за одну", () => {
    const d = { ...duty(), lastAlertIds: ["a"], lastAlertAt: 1_000_000 };
    expect(shouldNotifyGroup(d, [t("b")], 1_000_000 + GROUP_COOLDOWN_MS - 1).send).toBe(false);
    expect(shouldNotifyGroup(d, [t("b")], 1_000_000 + GROUP_COOLDOWN_MS + 1).send).toBe(true);
  });

  it("рівень «лише ракети» глушить шахеди", () => {
    const d = { ...duty(), level: "critical" as const };
    expect(shouldNotifyGroup(d, [t("a", false)], 10_000_000).send).toBe(false);
    expect(shouldNotifyGroup(d, [t("b", true)], 10_000_000).send).toBe(true);
  });

  it("порожній набір не будить нікого", () => {
    expect(shouldNotifyGroup(duty(), [], 10_000_000).send).toBe(false);
  });
});

describe("тексти", () => {
  it("панель пояснює, що персональні налаштування тут не діють", () => {
    expect(renderDuty(duty())).toContain("у групи вони свої");
  });
  it("довідка називає головне: одне налаштування прикриває весь чат", () => {
    expect(renderDutyHelp()).toContain("Двадцять людей прикриті одним налаштуванням");
  });
});
