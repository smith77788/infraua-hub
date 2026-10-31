import { describe, expect, it } from "bun:test";

import { classifyThreatType, type Threat } from "./air";
import {
  airActivityOf,
  applyJetType,
  JET_WINDOW_MS,
  jetMentions,
  parseChannelPage,
  applyBanderolType,
  typeMentions,
} from "./jet-sightings";

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

describe("тип — з рядка, а не з усього допису (прод, 31.10)", () => {
  // Агрегатори пишуть списком; «реактивний» в одному рядку не робить
  // реактивними пункти з інших рядків. Так 62 з 80 цілей ставали реактивними.
  const list = jetMentions(
    parseChannelPage(
      page([
        {
          at: NOW - 60_000,
          text: "🏍 Реактивний БпЛА на Любеч<br/>🛵 БпЛА на Куликівку<br/>🛵 БпЛА на Олевськ",
        },
      ]),
    ),
    NOW,
  );

  it("реактивним стає лише пункт із рядка про реактивний", () => {
    expect(applyJetType([drone("Любеч")], list)[0]!.type).toBe("reactive");
    expect(applyJetType([drone("Куликівка")], list)[0]!.type).toBe("shahed");
    expect(applyJetType([drone("Олевськ")], list)[0]!.type).toBe("shahed");
  });

  it("назва області — не пункт: «на Харківщині» не робить реактивним Харків", () => {
    const region = jetMentions(
      parseChannelPage(
        page([
          { at: NOW - 60_000, text: "🏍 Реактивні БпЛА на Харківщині" },
          { at: NOW - 60_000, text: "🏍 Реактивний БпЛА, Полтавська область" },
        ]),
      ),
      NOW,
    );
    expect(applyJetType([drone("Харків")], region)[0]!.type).toBe("shahed");
    expect(applyJetType([drone("Полтава")], region)[0]!.type).toBe("shahed");
  });

  it("а сам пункт поруч з областю — знаходиться", () => {
    const both = jetMentions(
      parseChannelPage(
        page([{ at: NOW - 60_000, text: "🏍 Харківщина: реактивний БпЛА курсом на Харків" }]),
      ),
      NOW,
    );
    expect(applyJetType([drone("Харків")], both)[0]!.type).toBe("reactive");
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

describe("applyBanderolType — «Бандероль» з каналів уточнює ціль джерела", () => {
  const NOW = Date.parse("2026-10-22T20:00:00Z");
  const base = {
    id: "n",
    lat: 47.84,
    lon: 35.14,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
  };
  // Дослівно radar_raketaa, 22.10.
  const msgs = [{ at: NOW - 3 * 60_000, text: "‼️ Бандеролі в напрямку Запоріжжя." }];

  it("«БпЛА» чи «ракета» Нептуна над названим пунктом стає «Бандероллю»", () => {
    const texts = typeMentions(msgs, NOW, "banderol");
    const out = applyBanderolType(
      [
        { ...base, name: "Запоріжжя", type: "shahed" as const },
        { ...base, id: "m", name: "Запоріжжя", type: "cruise" as const },
        { ...base, id: "k", name: "Запоріжжя", type: "kab" as const },
        { ...base, id: "d", name: "Дніпро", type: "shahed" as const },
      ],
      texts,
    );
    expect(out.map((t) => t.type)).toEqual(["banderol", "banderol", "kab", "shahed"]);
  });

  it("стара згадка (понад вікно) нічого не змінює", () => {
    const old = [{ at: NOW - 40 * 60_000, text: msgs[0]!.text }];
    expect(typeMentions(old, NOW, "banderol")).toEqual([]);
  });
});

describe("airActivityOf — чи канали говорять про цілі (27.10.2026, 23:39 UTC)", () => {
  const NOW = Date.parse("2026-10-27T23:40:00Z");
  const m = (min: number, channel: string, text: string) => ({
    at: NOW - min * 60_000,
    channel,
    text,
  });
  // Дослівно — той час, коли Нептун віддавав 0 цілей.
  const LIVE = [
    m(
      3,
      "PhantomChe",
      "Новий реактивний від Брянської, попередньо, під кордоном повз Славутич на Київщину.",
    ),
    m(19, "PhantomChe", "Ще звич.дрон під кордоном в районі Ріпки/Олешня."),
    m(20, "tlknewsua", "КАБ на Приколотное/Бурлук ⚠️"),
    m(18, "horizon_of_war_Official", "Чернігівщина\nРеактивний 🛵 на Добрянку -Любеч -Неданчичі"),
    m(20, "horizon_of_war_Official", "Відбій по балістиці"),
    m(19, "cherkasy_nebbo", "відбій ракетної небезпеки 📡"),
  ];

  it("живі цілі в кількох каналах — активність є, «відбій» не рахується", () => {
    expect(airActivityOf(LIVE, NOW)).toEqual({ messages: 4, channels: 3 });
  });

  it("лише відбої й старе — тиша", () => {
    expect(airActivityOf([LIVE[4]!, LIVE[5]!, m(40, "x", "Шахед на Київ")], NOW)).toEqual({
      messages: 0,
      channels: 0,
    });
  });
});
