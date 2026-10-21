import { describe, expect, it } from "bun:test";

import { borderKm, LAUNCH_WINDOW_MS, launchReach, launchSightings } from "./launch-sightings";

const NOW = Date.parse("2026-10-20T15:00:00Z");
const min = (m: number) => NOW - m * 60_000;

// Справжні повідомлення з превʼю каналів (2026-10-20).
const ERADAR = {
  at: min(11),
  text:
    "🛵 Загроза застосування ударних БпЛА типу «Shahed» та реактивних БпЛА. " +
    "Відмічено пуски: • Приморсько-Ахтарськ — 4 групи • ТО Крим — 2 групи (реактивні)",
};
const TEMPORIS = { at: min(13), text: "Зафіксовано пуски ✈️ ✈️ ✈️ з Приморськ-Ахтарську" };
const OREL = { at: min(40), text: "⚠️ Пуск реактивних з Орла, 6 груп" };
const OUTBOUND = {
  at: min(46),
  text: "Ще один Реактивний БпЛА вилетів в напрямку Лельчыцы (Білорусь) від Овруча (Житомирщина)",
};
const VOTE = {
  at: min(30),
  text: "У додатку «Київ Цифровий» стартувало голосування щодо перейменувань",
};

describe("launchSightings — пуски з повідомлень каналів", () => {
  const s = launchSightings([ERADAR, TEMPORIS, OREL, OUTBOUND, VOTE], NOW);
  const by = (k: string) => s.find((x) => x.key === k);

  it("розбирає перелік: кожен район — окремо, з кількістю груп", () => {
    expect(by("primorsko")!.groups).toBe(4);
    expect(by("crimea")!.groups).toBe(2);
    expect(by("orel")!.groups).toBe(6);
  });

  it("тип — з рядка району, а не з сусіднього: реактивні — лише кримські", () => {
    expect(by("crimea")!.type).toBe("reactive");
    expect(by("primorsko")!.type).toBe("shahed");
    expect(by("orel")!.type).toBe("reactive");
  });

  it("два повідомлення про той самий район зливаються, а не дублюються", () => {
    expect(by("primorsko")!.mentions).toBe(2);
    expect(by("primorsko")!.firstAt).toBe(min(13));
    expect(by("primorsko")!.lastAt).toBe(min(11));
  });

  it("наша ціль, що виходить з України, і «стартувало голосування» — не пуски", () => {
    expect(s.map((x) => x.key).sort()).toEqual(["crimea", "orel", "primorsko"]);
  });

  it("стара згадка поза вікном — уже не пуск цієї хвилі", () => {
    const old = launchSightings([{ at: NOW - LAUNCH_WINDOW_MS - 60_000, text: OREL.text }], NOW);
    expect(old).toHaveLength(0);
  });

  it("мис Чауда не дає другої позначки «Крим»", () => {
    const c = launchSightings(
      [{ at: min(5), text: "Пуски шахедів з району мису Чауда (Крим)" }],
      NOW,
    );
    expect(c.map((x) => x.key)).toEqual(["chauda"]);
  });

  it("розуміє російський текст — щоб російські канали можна було просто додати", () => {
    const r = launchSightings([{ at: min(5), text: "Запуск беспилотников из Брянска" }], NOW);
    expect(r.map((x) => x.key)).toEqual(["bryansk"]);
  });
});

describe("launchReach — як далеко могли долетіти", () => {
  it("шахед за годину від пуску — ~185 км; до кордону рахується від району", () => {
    const [p] = launchSightings([{ at: min(60), text: "Відмічено пуски шахедів: Курськ" }], NOW);
    const r = launchReach(p!, NOW);
    expect(r.reachKm).toBe(185);
    expect(r.borderKm).toBe(Math.round(borderKm(p!)));
    // Курськ ~ за 100 км від кордону — за годину шахеди вже могли перетнути.
    expect(r.toBorderMin).toBe(0);
  });

  it("тип невідомий — дуги не малюємо: швидкість «чогось» була б вигадкою", () => {
    const [p] = launchSightings([TEMPORIS], NOW);
    expect(p!.type).toBe("unknown");
    expect(launchReach(p!, NOW)).toMatchObject({ reachKm: 0, toBorderMin: null });
  });

  it("Крим — окупована Україна: «до кордону» не рахуємо", () => {
    const [c] = launchSightings(
      [{ at: min(15), text: "Відмічено пуски: ТО Крим — 2 групи (реактивні)" }],
      NOW,
    );
    expect(c!.occupied).toBe(true);
    expect(launchReach(c!, NOW).toBorderMin).toBeNull();
  });
});

describe("хибні пуски, спіймані на живих текстах російських каналів", () => {
  // Справжні тексти (2026-10-21): kurskN1, AhtariLive. Перша версія детектора
  // робила з них «пуск із Курська» і «пуск із Криму».
  const KURSK_HEATING =
    "🔥 Отопление в Курске начнут включать в течение пяти дней Сегодня в Курске стартует " +
    "отопительный сезон. Подключать многоквартирные дома будут поэтапно. После запуска отопления";
  const AHTARI_BRIDGE =
    "От первых «Сапсанов» до старта строительства новой высокоскоростной магистрали, " +
    "от Крымского моста до мощнейшего атомного ледокола.";

  it("«стартует отопительный сезон… после запуска отопления» — не пуск", () => {
    expect(launchSightings([{ at: min(5), text: KURSK_HEATING }], NOW)).toHaveLength(0);
  });

  it("«Крымского моста» — не Крим, «старт строительства» — не пуск", () => {
    expect(launchSightings([{ at: min(5), text: AHTARI_BRIDGE }], NOW)).toHaveLength(0);
  });

  it("однина «Пуск реактивних з Орла» — справжній пуск і лишається ним", () => {
    expect(launchSightings([OREL], NOW).map((x) => x.key)).toEqual(["orel"]);
  });
});

describe("російські канали — лише як джерело пусків", () => {
  const RU = (channel: string | undefined): { ru: boolean; home?: string } =>
    channel === "AhtariLive"
      ? { ru: true, home: "primorsko" }
      : { ru: (channel ?? "").startsWith("ru_") };

  it("місцевий канал без назви міста — його домашній район, з позначкою походження", () => {
    const s = launchSightings(
      [{ at: min(4), text: "Опять запуски, гул над городом, летят герани", channel: "AhtariLive" }],
      NOW,
      RU,
    );
    expect(s.map((x) => x.key)).toEqual(["primorsko"]);
    expect(s[0]!.ruSource).toBe(true);
    expect(s[0]!.sources).toEqual(["AhtariLive"]);
  });

  it("повідомлення про НАШІ атаки на них — не їхній пуск", () => {
    const s = launchSightings(
      [{ at: min(4), text: "ВСУ осуществили запуск беспилотников по Курску", channel: "ru_x" }],
      NOW,
      RU,
    );
    expect(s).toHaveLength(0);
  });

  it("місцевий канал без дієслова пуску — нічого (опасность атаки БПЛА — це не пуск)", () => {
    const s = launchSightings(
      [
        {
          at: min(4),
          text: "Внимание: опасность атаки БПЛА, отойдите от окон",
          channel: "AhtariLive",
        },
      ],
      NOW,
      RU,
    );
    expect(s).toHaveLength(0);
  });
});
