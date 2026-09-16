import { describe, expect, it } from "bun:test";

import {
  decideCircleAlert,
  distanceBand,
  pendingCheckins,
  CIRCLE_ALERT_COOLDOWN_MS,
  type CircleMemberState,
} from "./circle-alert";

describe("distanceBand", () => {
  it("ніколи не видає точного числа — лише смугу", () => {
    expect(distanceBand(4)).toBe("ближче 10 км");
    expect(distanceBand(20)).toBe("10–30 км");
    expect(distanceBand(45)).toBe("30–60 км");
    expect(distanceBand(120)).toBe("далі 60 км");
    expect(distanceBand(null)).toBe("поруч");
  });
});

describe("decideCircleAlert", () => {
  const base = {
    name: "Мама",
    circleName: "Родина",
    nearestKm: 6,
    lastCircleAlertAt: null,
    now: 1_000_000,
  };

  it("рівень «в укриття» — сповіщаємо, без координат", () => {
    const d = decideCircleAlert({ ...base, level: "shelter" });
    expect(d.send).toBe(true);
    expect(d.text).toContain("Мама");
    expect(d.text).toContain("ближче 10 км");
    expect(d.text).not.toContain("6");
  });

  it("нижчий рівень не піднімає рідних", () => {
    expect(decideCircleAlert({ ...base, level: "attention" }).send).toBe(false);
    expect(decideCircleAlert({ ...base, level: "watch" }).send).toBe(false);
  });

  it("кулдаун глушить повтор про ту саму людину", () => {
    const d = decideCircleAlert({
      ...base,
      level: "shelter",
      lastCircleAlertAt: base.now - CIRCLE_ALERT_COOLDOWN_MS + 1000,
    });
    expect(d.send).toBe(false);
  });

  it("після кулдауну можна знову", () => {
    const d = decideCircleAlert({
      ...base,
      level: "shelter",
      lastCircleAlertAt: base.now - CIRCLE_ALERT_COOLDOWN_MS - 1,
    });
    expect(d.send).toBe(true);
  });

  it("екранує імена (анти-HTML-інʼєкція)", () => {
    const d = decideCircleAlert({ ...base, name: "<b>x", circleName: "a<b", level: "shelter" });
    expect(d.text).not.toContain("<b>x");
    expect(d.text).toContain("&lt;b&gt;x");
  });
});

describe("pendingCheckins", () => {
  const now = 10_000_000;
  const mk = (o: Partial<CircleMemberState> & { chatId: number }): CircleMemberState => ({
    name: "X",
    lastDangerAt: null,
    okAt: null,
    ...o,
  });

  it("показує тих, хто був у небезпеці й не відмітився", () => {
    const list = pendingCheckins(
      [
        mk({ chatId: 1, name: "Тато", lastDangerAt: now - 10 * 60_000, okAt: null }),
        mk({ chatId: 2, name: "Мама", lastDangerAt: now - 10 * 60_000, okAt: now - 5 * 60_000 }),
      ],
      now,
    );
    expect(list.map((x) => x.chatId)).toEqual([1]);
  });

  it("відмітка ПЕРЕД небезпекою не рахується підтвердженням", () => {
    const list = pendingCheckins(
      [mk({ chatId: 3, lastDangerAt: now - 5 * 60_000, okAt: now - 20 * 60_000 })],
      now,
    );
    expect(list).toHaveLength(1);
  });

  it("стара небезпека поза вікном не тривожить", () => {
    const list = pendingCheckins(
      [mk({ chatId: 4, lastDangerAt: now - 3 * 60 * 60_000, okAt: null })],
      now,
    );
    expect(list).toHaveLength(0);
  });

  it("найдавніша без відмітки — перша", () => {
    const list = pendingCheckins(
      [
        mk({ chatId: 5, lastDangerAt: now - 5 * 60_000 }),
        mk({ chatId: 6, lastDangerAt: now - 40 * 60_000 }),
      ],
      now,
    );
    expect(list.map((x) => x.chatId)).toEqual([6, 5]);
  });
});
