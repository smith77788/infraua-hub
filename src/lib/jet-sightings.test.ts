import { describe, expect, it } from "bun:test";

import { classifyThreatType, type Threat } from "./air";
import { applyJetType, JET_WINDOW_MS, jetMentions, parseChannelPage } from "./jet-sightings";

const NOW = Date.parse("2026-10-20T13:30:00Z");

// Розмітка превʼю t.me/s/<канал> — у тій формі, що віддає Telegram; тексти —
// справжні повідомлення kpszsu (2026-10-20).
function page(msgs: { at: number; text: string }[]): string {
  return msgs
    .map(
      (m) =>
        `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message">` +
        `<div class="tgme_widget_message_text js-message_text" dir="auto">${m.text}</div>` +
        `<a class="tgme_widget_message_date"><time datetime="${new Date(m.at).toISOString()}" class="time">13:20</time></a></div></div>`,
    )
    .join("");
}

function drone(name: string, type: Threat["type"] = "shahed"): Threat {
  return {
    id: name,
    name,
    lat: 50,
    lon: 30,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    type,
  };
}

describe("parseChannelPage", () => {
  it("читає час і текст кожного повідомлення", () => {
    const msgs = parseChannelPage(
      page([{ at: NOW - 60_000, text: "🏍 Реактивний БпЛА повз Димер,<br/> курсом на Київ." }]),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.at).toBe(NOW - 60_000);
    expect(msgs[0]!.text).toContain("курсом на Київ");
  });

  it("повідомлення без часу пропускається: свіжість тоді не перевірити", () => {
    const html = page([{ at: NOW, text: "🏍 Реактивний БпЛА" }]).replace(/datetime="[^"]+"/, "");
    expect(parseChannelPage(html)).toHaveLength(0);
  });
});

describe("applyJetType — реактивний за свіжою згадкою каналу", () => {
  const msgs = parseChannelPage(
    page([
      { at: NOW - 5 * 60_000, text: "🏍 Реактивний БпЛА повз Димер, курсом на Київ." },
      { at: NOW - 8 * 60_000, text: "🏍 Одещина: реактивні БпЛА курсом на Ширяєве та Березівку." },
      { at: NOW - 3 * 60_000, text: "🛵 БпЛА курсом на Олевськ." },
    ]),
  );
  const jet = jetMentions(msgs, NOW);

  it("пункт зі свіжої згадки про реактивний — ціль стає реактивною", () => {
    expect(applyJetType([drone("Димер")], jet)[0]!.type).toBe("reactive");
    expect(applyJetType([drone("Ширяєве")], jet)[0]!.type).toBe("reactive");
  });

  it("відмінок не заважає: «Березівку» — це Березівка", () => {
    expect(applyJetType([drone("Березівка")], jet)[0]!.type).toBe("reactive");
  });

  it("звичайний «БпЛА» поруч не робить ціль реактивною", () => {
    expect(applyJetType([drone("Олевськ")], jet)[0]!.type).toBe("shahed");
  });

  it("стара згадка — вже інша хвиля: не рахується", () => {
    const old = jetMentions(
      parseChannelPage(
        page([{ at: NOW - JET_WINDOW_MS - 60_000, text: "🏍 Реактивний БпЛА на Димер" }]),
      ),
      NOW,
    );
    expect(applyJetType([drone("Димер")], old)[0]!.type).toBe("shahed");
  });

  it("ракету чи КАБ ознака не чіпає — лише дрони", () => {
    expect(applyJetType([drone("Димер", "cruise")], jet)[0]!.type).toBe("cruise");
  });

  it("назва не знаходиться всередині іншого слова", () => {
    const j = jetMentions(
      parseChannelPage(page([{ at: NOW - 60_000, text: "🏍 Реактивний БпЛА над Новодимером" }])),
      NOW,
    );
    expect(applyJetType([drone("Димер")], j)[0]!.type).toBe("shahed");
  });
});

describe("FPV — окремий тип, а не «шахед»", () => {
  it("текст «FPV-дрон» класифікується як FPV, хоч і містить слово «дрон»", async () => {
    const { classifyThreatType } = await import("./air");
    expect(classifyThreatType("FPV-дрон біля Херсона")).toBe("fpv");
    expect(classifyThreatType("БпЛА курсом на Олевськ")).toBe("shahed");
  });

  it("запис Нептуна з типом fpv лишається FPV (живий фід: 4 з 15 цілей)", async () => {
    const { mapNeptunThreat } = await import("./neptun-map");
    const t = mapNeptunThreat({
      id: "f",
      type: "fpv",
      title: "FPV-дрон",
      lat: 46.6,
      lon: 32.6,
      status: "active",
      explanationShort: "FPV-дрон — Херсон.",
    });
    expect(t!.type).toBe("fpv");
  });
});

describe("«реактивний» без слова БпЛА — справжні дописи каналів", () => {
  /*
   * Усі рядки нижче — дослівні дописи наших же каналів за 19–20.10.2026.
   * Заміряно: із 32 згадок «реактивн» попередній вираз ловив 24, а ці 8
   * пропускав. Саме вони й називають пункт, тобто саме за ними `applyJetType`
   * і мав би піднімати ціль у реактивні.
   */
  const REAL = [
    "Один звичайний вздовж ДЕРЖАВНОГО кордону І один реактивний в напрямку Рокитне",
    "Костопіль 1 реактивний Жадень 1 звичайний",
    "Реактивний повернув в напрямку Костопіль-Головин",
    "Найближчий реактивний на Житомирщині поки не до нас",
    "Наступні 2 реактивні на півночі Житомирщини курсом на Рівненщину",
    "новий реактивний залітає на північ Житомирщини",
  ];

  it("кожен такий допис тепер розпізнається як реактивний", () => {
    for (const text of REAL) expect(classifyThreatType(text)).toBe("reactive");
  });

  it("форма зі словом БпЛА працює як раніше", () => {
    expect(classifyThreatType("⚠️Реактивний БпЛА на півночі н.п. Березне Рівненщина")).toBe(
      "reactive",
    );
  });

  it("реактивна артилерія — не наш клас цілі й не підіймає дрон", () => {
    // Інакше згадка про РСЗВ піднімала б у реактивні сусідній дрон за
    // назвою пункту, тобто вкорочувала б час підльоту на підставі чужої події.
    expect(classifyThreatType("Обстріл з реактивної артилерії по Куп'янську")).not.toBe("reactive");
    expect(classifyThreatType("Зафіксовано реактивний снаряд")).not.toBe("reactive");
  });

  it("«звичайний» лишається звичайним", () => {
    expect(classifyThreatType("1 звичайний керований на Острівськ")).not.toBe("reactive");
  });

  it("пункт із пропущеного раніше допису справді піднімає ціль", () => {
    const now = Date.now();
    const msgs = [{ at: now - 60_000, text: "Костопіль 1 реактивний Жадень 1 звичайний" }];
    const threats = [
      {
        id: "1",
        name: "Костопіль",
        lat: 50.88,
        lon: 26.45,
        source: "n",
        count: 1,
        since: "",
        expires: "",
        type: "shahed" as const,
      },
      {
        id: "2",
        name: "Львів",
        lat: 49.84,
        lon: 24.03,
        source: "n",
        count: 1,
        since: "",
        expires: "",
        type: "shahed" as const,
      },
    ];
    const out = applyJetType(threats, jetMentions(msgs, now));
    expect(out[0]!.type).toBe("reactive");
    expect(out[1]!.type).toBe("shahed"); // чужий пункт не чіпаємо
  });
});
