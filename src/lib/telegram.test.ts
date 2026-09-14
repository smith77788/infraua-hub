import { describe, expect, it } from "bun:test";

import {
  ADMIN_ACTIONS,
  adminKeyboard,
  callbackToast,
  escapeHtml,
  isAdminAction,
  isOwner,
  miniAppKeyboard,
  ownerCommands,
  parseCallback,
  parseCommand,
  parseLayersArg,
  parseLocation,
  publicCommands,
  purgeKeyboard,
  renderAdminPanel,
  renderHelp,
  renderLayers,
  renderPurgePreview,
  renderStart,
  renderStatus,
  renderUnknown,
  secretMatches,
  senderId,
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

describe("власник розгортання", () => {
  it("не існує, поки його не задали — і тоді команд немає ні в кого", () => {
    // Усталене значення відкритого доступу в елементі контролю доступу — це не
    // зручність, а дірка. Порожня змінна не має означати «дозволено всім».
    expect(isOwner(12345, undefined)).toBe(false);
    expect(isOwner(12345, "")).toBe(false);
    expect(isOwner(12345, "   ")).toBe(false);
  });

  it("це точний збіг ідентифікатора, а не схожість", () => {
    expect(isOwner(12345, "12345")).toBe(true);
    expect(isOwner(12345, " 12345 ")).toBe(true);
    // Ті, що виглядають схоже: префікс, суфікс, інший акаунт.
    expect(isOwner(1234, "12345")).toBe(false);
    expect(isOwner(123456, "12345")).toBe(false);
    expect(isOwner(54321, "12345")).toBe(false);
  });

  it("не пускає, коли відправника в оновленні немає", () => {
    // Пости в каналі приходять без `from`. Без цієї перевірки `undefined`
    // порівнювався б із рядком і міг би збігтися випадково.
    expect(isOwner(undefined, "12345")).toBe(false);
  });

  it("береться з того, ХТО написав, а не з чату", () => {
    // У групі chatId спільний: звірка з ним відкрила б команди всім у групі.
    const update = {
      message: { chat: { id: -100200, type: "group" }, from: { id: 777 }, text: "/layers" },
    };
    expect(senderId(update)).toBe(777);
    expect(isOwner(senderId(update), "-100200")).toBe(false);
    expect(isOwner(senderId(update), "777")).toBe(true);
  });
});

describe("аргумент /layers", () => {
  it("без аргументу — це запит стану, а не зміна", () => {
    expect(parseLayersArg("")).toBe(null);
    expect(parseLayersArg("   ")).toBe(null);
  });

  it("розуміє обидві мови й не вгадує решту", () => {
    expect(parseLayersArg("on")).toBe(true);
    expect(parseLayersArg(" OFF ")).toBe(false);
    expect(parseLayersArg("увімк")).toBe(true);
    expect(parseLayersArg("вимк")).toBe(false);
    // Вгадування тут коштувало б вмикання шарів замість вимикання.
    expect(parseLayersArg("enable")).toBe("invalid");
    expect(parseLayersArg("да")).toBe("invalid");
  });
});

describe("що бот показує про вимикач", () => {
  it("розрізняє дві половини, бо крутяться вони в різних місцях", () => {
    const text = renderLayers({ enabled: false, permitted: false, switchedOn: true });
    // Ручка увімкнена, а дозволу немає: одне слово «вимкнено» відправило б
    // власника крутити не те.
    expect(text).toContain("Ручка оператора: увімк");
    expect(text).toContain("Дозвіл розгортання: <b>немає</b>");
    expect(text).toContain("INFRA_LAYERS=on");
  });

  it("каже «увімкнено» лише коли обидві половини відкриті", () => {
    expect(renderLayers({ enabled: true, permitted: true, switchedOn: true })).toContain(
      "УВІМКНЕНО",
    );
    expect(renderLayers({ enabled: false, permitted: true, switchedOn: false })).toContain(
      "вимкнено",
    );
  });

  it("прибирання спершу показує, що прибере", () => {
    const preview = renderPurgePreview(["infraua-console"], ["infraua-console", "prozorro"]);
    expect(preview).toContain("infraua-console");
    expect(preview).toContain("/purge yes");
    // Незворотність названа, а не мається на увазі.
    expect(preview).toContain("незворотно");
  });

  it("у панелі з кнопками не пропонує ще й набрати команду", () => {
    // Два способи зробити одне поруч — читач гадає, чи вони однакові.
    const withButtons = renderPurgePreview(["infraua-console"], ["infraua-console"], true);
    expect(withButtons).not.toContain("/purge yes");
    expect(withButtons).toContain("незворотно");
  });

  it("порожній граф не виглядає як зроблена робота", () => {
    expect(renderPurgePreview([], ["prozorro"])).toContain("прибирати нічого");
  });
});

describe("натискання кнопок адмін-панелі", () => {
  const press = (data: string, fromId = 777) => ({
    callback_query: {
      id: "cb-1",
      from: { id: fromId },
      message: { message_id: 42, chat: { id: 999 } },
      data,
    },
  });

  it("розбирається з окремого типу оновлення, не з повідомлення", () => {
    const parsed = parseCallback(press("l:on"))!;
    expect(parsed.callbackId).toBe("cb-1");
    expect(parsed.userId).toBe(777);
    expect(parsed.chatId).toBe(999);
    expect(parsed.messageId).toBe(42);
    // Звичайне повідомлення не є натисканням.
    expect(parseCallback({ message: { chat: { id: 1 }, text: "/admin" } })).toBe(null);
  });

  it("дає `from` натискача, а не автора повідомлення з кнопками", () => {
    // Панель можна переслати в інший чат — тиснути буде інший акаунт. Право
    // дає той, хто натиснув, а не той, кому колись показали.
    const parsed = parseCallback(press("l:off", 12345))!;
    expect(isOwner(parsed.userId, "777")).toBe(false);
    expect(isOwner(parsed.userId, "12345")).toBe(true);
  });

  it("не приймає коду, якого не показувала", () => {
    // `callback_data` приходить від клієнта, тож це вхід ззовні, а не наш
    // власний рядок, яким його легко вважати.
    expect(isAdminAction("l:on")).toBe(true);
    expect(isAdminAction("p:go")).toBe(true);
    expect(isAdminAction("l:maybe")).toBe(false);
    expect(isAdminAction("../../etc")).toBe(false);
    expect(isAdminAction("")).toBe(false);
  });

  it("кожен код влазить у стелю Telegram на 64 байти", () => {
    for (const value of Object.values(ADMIN_ACTIONS)) {
      // За цією межею кнопка просто не працює, і мовчки.
      expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(64);
    }
  });
});

describe("кнопки під станом", () => {
  const state = (switchedOn: boolean, permitted = true) => ({
    enabled: switchedOn && permitted,
    permitted,
    switchedOn,
  });

  it("називають дію, а не поточне положення", () => {
    // «Шари: увімк» на кнопці половина прочитає як стан, половина — як дію, і
    // ціна помилки в один бік значно вища.
    const off = adminKeyboard(state(false)).inline_keyboard.flat();
    expect(off[0]!.text).toContain("Увімкнути");
    expect(off[0]!.callback_data).toBe(ADMIN_ACTIONS.layersOn);

    const on = adminKeyboard(state(true)).inline_keyboard.flat();
    expect(on[0]!.text).toContain("Вимкнути");
    expect(on[0]!.callback_data).toBe(ADMIN_ACTIONS.layersOff);
  });

  it("попереджають, коли вмикати нема чого — дозволу немає", () => {
    const buttons = adminKeyboard(state(false, false)).inline_keyboard.flat();
    // Інакше: натиснув, нічого не змінилося, виглядає як поломка.
    expect(buttons[0]!.text).toContain("дозволу немає");
  });

  it("незворотну дію не роблять одним дотиком", () => {
    const first = adminKeyboard(state(true)).inline_keyboard.flat();
    expect(first.some((b) => b.callback_data === ADMIN_ACTIONS.purgeConfirm)).toBe(false);
    expect(first.some((b) => b.callback_data === ADMIN_ACTIONS.purgePreview)).toBe(true);

    // Підтвердження зʼявляється лише на другому кроці, і поруч є вихід.
    const second = purgeKeyboard().inline_keyboard.flat();
    expect(second.some((b) => b.callback_data === ADMIN_ACTIONS.purgeConfirm)).toBe(true);
    expect(second.some((b) => b.callback_data === ADMIN_ACTIONS.refresh)).toBe(true);
  });

  it("панель показує обидві половини вимикача", () => {
    const text = renderAdminPanel(state(true, false));
    expect(text).toContain("Адмін-панель");
    expect(text).toContain("Ручка оператора: увімк");
    expect(text).toContain("Дозвіл розгортання: <b>немає</b>");
    // Підказка про текстові команди в панелі з кнопками зайва.
    expect(text).not.toContain("/layers on");
  });

  it("спливний напис каже правду, коли ручка увімкнена без дозволу", () => {
    const toast = callbackToast(ADMIN_ACTIONS.layersOn, state(true, false));
    expect(toast).toContain("дозволу розгортання немає");
    expect(callbackToast(ADMIN_ACTIONS.layersOn, state(true, true))).toBe("Шари увімкнено");
  });
});

describe("перелік команд для меню Telegram", () => {
  it("публічні команди містять status/start/help", () => {
    const names = publicCommands().map((c) => c.command);
    expect(names).toContain("status");
    expect(names).toContain("help");
    expect(names).not.toContain("admin");
  });

  it("власник бачить /admin у своєму переліку", () => {
    const names = ownerCommands().map((c) => c.command);
    expect(names).toContain("admin");
    expect(names).toContain("layers");
    expect(names).toContain("purge");
  });

  it("усі команди мають несуфіксовану назву й опис", () => {
    for (const c of ownerCommands()) {
      expect(c.command).toMatch(/^[a-z_]+$/); // Telegram вимагає a-z0-9_
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe("parseLocation", () => {
  it("дістає точку з повідомлення без тексту", () => {
    // Саме цей випадок раніше тихо відкидався: кнопка «надіслати точку» шле
    // повідомлення БЕЗ поля text, а parseCommand вимагає рядка з «/».
    expect(
      parseLocation({
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 7 },
          location: { latitude: 50.45, longitude: 30.52 },
        },
      }),
    ).toEqual({ chatId: 42, userId: 7, chatType: "private", lat: 50.45, lon: 30.52 });
  });

  it("звичайна команда — не геолокація", () => {
    expect(parseLocation({ message: { chat: { id: 1 }, text: "/my" } })).toBeNull();
  });

  it("координати поза межами глобуса відкидаються", () => {
    expect(
      parseLocation({
        message: { chat: { id: 1 }, location: { latitude: 999, longitude: 30 } },
      }),
    ).toBeNull();
  });
});

describe("перелік команд", () => {
  it("персональний радар стоїть першим у меню — це головне, заради чого бот", () => {
    expect(publicCommands()[0]!.command).toBe("my");
  });
  it("описи вкладаються в 256 символів, які дозволяє setMyCommands", () => {
    for (const c of ownerCommands()) {
      expect(c.description.length).toBeLessThanOrEqual(256);
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });
});
