import { describe, expect, it } from "bun:test";

import {
  escapeHtml,
  parseCommand,
  renderHelp,
  renderStart,
  renderStatus,
  miniAppKeyboard,
  renderUnknown,
  secretMatches,
} from "./telegram";

const CONSOLE = "https://infraua-hub-production.up.railway.app";

function update(text: string, chatId = 42) {
  return { update_id: 1, message: { message_id: 7, chat: { id: chatId }, text } };
}

describe("parseCommand", () => {
  it("розбирає команду з аргументами", () => {
    expect(parseCommand(update("/status зараз"))).toEqual({
      chatId: 42,
      command: "status",
      args: "зараз",
      chatType: "private",
    });
  });

  it("знімає суфікс бота — інакше в групах він мовчить завжди", () => {
    // У групі Telegram шле саме `/status@Radar_UAbot`.
    expect(parseCommand(update("/status@Radar_UAbot"))?.command).toBe("status");
  });

  it("не реагує на звичайний текст", () => {
    expect(parseCommand(update("привіт"))).toBeNull();
  });

  it("мовчить на оновленнях, що не є повідомленнями", () => {
    // Telegram шле редагування, вступи в чат, реакції. Відповідати на все —
    // це спам, тому «нічого робити» тут нормальний випадок.
    expect(parseCommand({ update_id: 1, edited_message: { text: "/status" } })).toBeNull();
    expect(parseCommand({})).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand("не обʼєкт")).toBeNull();
  });

  it("не падає на повідомленні без чату чи тексту", () => {
    expect(parseCommand({ message: { text: "/status" } })).toBeNull();
    expect(parseCommand({ message: { chat: { id: 1 } } })).toBeNull();
  });

  it("не вважає командою самий слеш", () => {
    expect(parseCommand(update("/"))).toBeNull();
  });

  it("нечутливий до регістру", () => {
    expect(parseCommand(update("/STATUS"))?.command).toBe("status");
  });
});

describe("secretMatches", () => {
  it("приймає точний збіг", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
  });

  it("відхиляє все інше", () => {
    expect(secretMatches("s3cret", "wrong")).toBe(false);
    expect(secretMatches("s3cret", null)).toBe(false);
    expect(secretMatches("s3cret", "")).toBe(false);
  });

  it("без заданого секрету не пускає нікого", () => {
    // Інакше забута змінна середовища тихо відкриває вебхук усьому світу:
    // адреса — не таємниця.
    expect(secretMatches(undefined, "будь-що")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});

describe("renderStatus", () => {
  const base = {
    alarmRegions: [] as string[],
    eventsLastDay: 3,
    sources: [
      { name: "OSM", ok: true },
      { name: "USGS", ok: true },
    ],
    consoleUrl: CONSOLE,
  };

  it("каже про спокій, коли тривог немає", () => {
    const out = renderStatus(base);
    expect(out).toContain("Активних тривог немає");
    expect(out).toContain("усі 2 відповідають");
  });

  it("перелічує області з тривогою", () => {
    const out = renderStatus({ ...base, alarmRegions: ["Київщина", "Одещина"] });
    expect(out).toContain("2 обл.");
    expect(out).toContain("Київщина, Одещина");
  });

  it("обрізає довгий перелік і каже, що обрізав", () => {
    // Мовчки обрізаний список читається як повний.
    const many = Array.from({ length: 13 }, (_, i) => `Обл${i}`);
    const out = renderStatus({ ...base, alarmRegions: many });
    expect(out).toContain("і ще 5");
  });

  it("називає джерела, які не відповідають", () => {
    const out = renderStatus({
      ...base,
      sources: [
        { name: "OSM", ok: false },
        { name: "USGS", ok: true },
      ],
    });
    expect(out).toContain("не відповідають — OSM");
  });

  it("екранує назви, щоб амперсанд не ламав повідомлення", () => {
    const out = renderStatus({ ...base, alarmRegions: ["Що & як"] });
    expect(out).toContain("Що &amp; як");
  });
});

describe("escapeHtml", () => {
  it("екранує символи розмітки", () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;"');
  });
});

describe("тексти команд", () => {
  it("завжди ведуть у консоль", () => {
    for (const text of [renderStart(CONSOLE), renderHelp(CONSOLE)]) {
      expect(text).toContain(CONSOLE);
    }
  });

  it("невідома команда отримує відповідь, а не мовчання", () => {
    // Мовчання виглядає як поломка бота.
    expect(renderUnknown("щось")).toContain("/help");
  });

  it("екранує невідому команду, а не вставляє її як розмітку", () => {
    expect(renderUnknown("<b>")).toContain("&lt;b&gt;");
  });
});

describe("miniAppKeyboard", () => {
  it("дає кнопку в приватному чаті", () => {
    const kb = miniAppKeyboard(CONSOLE, "private")!;
    expect(kb.inline_keyboard[0]![0]!.web_app.url).toBe(CONSOLE);
  });

  it("не дає кнопки в групі — інакше повідомлення не доходить узагалі", () => {
    // Telegram відхиляє запит із web_app-кнопкою в групі цілком, а не просто
    // ігнорує кнопку.
    expect(miniAppKeyboard(CONSOLE, "group")).toBeUndefined();
    expect(miniAppKeyboard(CONSOLE, "supergroup")).toBeUndefined();
    expect(miniAppKeyboard(CONSOLE, "channel")).toBeUndefined();
  });
});

describe("parseCommand — тип чату", () => {
  it("повертає тип чату разом із командою", () => {
    expect(
      parseCommand({ message: { chat: { id: 5, type: "supergroup" }, text: "/status" } })?.chatType,
    ).toBe("supergroup");
  });

  it("без типу вважає чат приватним", () => {
    expect(parseCommand(update("/status"))?.chatType).toBe("private");
  });
});
