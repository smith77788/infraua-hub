import { describe, expect, it } from "bun:test";

import {
  GATE_ACTION,
  channelUrl,
  gateKeyboard,
  isSubscribed,
  justLeft,
  justSubscribed,
  renderAccessOpened,
  renderGate,
  renderStillNotSubscribed,
  urlFromChat,
} from "./gate";

describe("isSubscribed", () => {
  it("власник, адміністратор і учасник — у каналі", () => {
    expect(isSubscribed("creator")).toBe(true);
    expect(isSubscribed("administrator")).toBe(true);
    expect(isSubscribed("member")).toBe(true);
  });

  it("той, хто вийшов або кого вигнали, — ні", () => {
    expect(isSubscribed("left")).toBe(false);
    expect(isSubscribed("kicked")).toBe(false);
  });

  it("«обмежений» доводиться прапорцем, а не статусом", () => {
    // Прирівняти restricted до «в каналі» означало б пускати тих, кого з
    // каналу фактично вигнали.
    expect(isSubscribed("restricted", true)).toBe(true);
    expect(isSubscribed("restricted", false)).toBe(false);
    expect(isSubscribed("restricted")).toBe(false);
  });

  it("невідомий статус не вважається підпискою", () => {
    expect(isSubscribed(undefined)).toBe(false);
    expect(isSubscribed("щось нове")).toBe(false);
  });
});

describe("channelUrl", () => {
  it("з @username робить посилання", () => {
    expect(channelUrl("@radar_ua")).toBe("https://t.me/radar_ua");
  });

  it("числовий id посилання не дає — і це не помилка", () => {
    // Без посилання гейт неможливий по суті: ми не можемо показати людині,
    // КУДИ підписуватись, тож замикати її в цьому стані не можна.
    expect(channelUrl("-1001234567890")).toBeNull();
    expect(channelUrl(undefined)).toBeNull();
    expect(channelUrl("  ")).toBeNull();
  });

  it("готове посилання лишається як є", () => {
    expect(channelUrl("https://t.me/radar_ua")).toBe("https://t.me/radar_ua");
  });
});

describe("екран гейту", () => {
  it("пояснює причину, а не ставить умову", () => {
    const text = renderGate("https://t.me/x");
    expect(text).toContain("одне ціле");
    expect(text).toContain("https://t.me/x");
  });

  it("каже, що саме перевіряється — і що більше нічого", () => {
    expect(renderGate("https://t.me/x")).toContain("лише факт підписки");
  });

  it("кнопки: одна веде в канал, друга перевіряє наново", () => {
    const kb = gateKeyboard("https://t.me/x");
    expect(kb.inline_keyboard[0]![0]).toHaveProperty("url", "https://t.me/x");
    expect(kb.inline_keyboard[1]![0]).toHaveProperty("callback_data", GATE_ACTION);
  });

  it("код кнопки вкладається в 64 байти", () => {
    expect(Buffer.byteLength(GATE_ACTION)).toBeLessThanOrEqual(64);
  });

  it("не звинувачує людину, коли підписки ще не видно", () => {
    // Telegram оновлює членство із затримкою; «ви не підписались» тут було б
    // звинуваченням у тому, що людина щойно зробила.
    expect(renderStillNotSubscribed()).toContain("затримкою");
  });
});

/*
 * Перехід членства — те, чим гейт замикається. Без нього людина, яка
 * підписалась і просто повторила команду, впиралась у ту саму відмову, бо
 * перевірка кешується.
 */
describe("justSubscribed / justLeft — переходи членства", () => {
  it("вхід у канал — це підписка", () => {
    expect(justSubscribed("left", "member")).toBe(true);
    expect(justSubscribed(undefined, "member")).toBe(true);
  });

  it("підвищення вже підписаного — не підписка", () => {
    // Інакше бот вітав би людину з підпискою, якої вона зараз не робила.
    expect(justSubscribed("member", "administrator")).toBe(false);
    expect(justSubscribed("administrator", "creator")).toBe(false);
  });

  it("обмежений без членства не вважається підписаним", () => {
    expect(justSubscribed("left", "restricted", false)).toBe(false);
    expect(justSubscribed("left", "restricted", true)).toBe(true);
  });

  it("вихід і бан — це вихід", () => {
    expect(justLeft("member", "left")).toBe(true);
    expect(justLeft("administrator", "kicked")).toBe(true);
  });

  it("вихід того, кого й не було, — не подія", () => {
    expect(justLeft("left", "kicked")).toBe(false);
  });

  it("переходи взаємно виключні", () => {
    for (const [o, n] of [
      ["left", "member"],
      ["member", "left"],
      ["member", "administrator"],
    ] as const) {
      expect(justSubscribed(o, n) && justLeft(o, n)).toBe(false);
    }
  });
});

describe("renderAccessOpened", () => {
  it("не ставить наступної умови", () => {
    const t = renderAccessOpened();
    expect(t).toContain("радар відкрито");
    expect(t).not.toContain("підпиш");
  });
});

/*
 * Вада, через яку гейт був ВИМКНЕНИЙ у проді й ніхто цього не бачив.
 *
 * `TELEGRAM_CHANNEL_ID` там задано числом (`-100…`) — для `getChatMember` і
 * для постингу цього досить. Але посилання з числа не зробити, `channelUrl`
 * повертав `null`, а `subscriptionGate` на `null` пускає всіх за
 * запобіжником «не вдалося перевірити → пускаємо». Гейт мовчки не існував,
 * хоча код був на місці й покритий тестами.
 */
describe("channelUrl — межа того, що можна вивести з налаштування", () => {
  it("числовий id посилання не дає — і це треба знати, а не вгадувати", () => {
    expect(channelUrl("-1004308272279")).toBeNull();
  });

  it("@username дає публічне посилання", () => {
    expect(channelUrl("@Info_Radar")).toBe("https://t.me/Info_Radar");
  });

  it("готове посилання береться як є", () => {
    expect(channelUrl("https://t.me/Info_Radar")).toBe("https://t.me/Info_Radar");
  });
});

describe("urlFromChat — адресу питаємо в Telegram", () => {
  it("публічний канал: username", () => {
    expect(urlFromChat({ username: "Info_Radar" })).toBe("https://t.me/Info_Radar");
  });

  it("закритий канал: посилання-запрошення", () => {
    // Саме воно потрібне людині, якій ми кажемо «підпишіться».
    expect(urlFromChat({ invite_link: "https://t.me/+4n7FS6IP1sAwNWQy" })).toBe(
      "https://t.me/+4n7FS6IP1sAwNWQy",
    );
  });

  it("username важливіший за запрошення", () => {
    expect(urlFromChat({ username: "Info_Radar", invite_link: "https://t.me/+abc" })).toBe(
      "https://t.me/Info_Radar",
    );
  });

  it("чужа адреса у відповіді не стає посиланням на канал", () => {
    expect(urlFromChat({ invite_link: "https://example.com/phish" })).toBeNull();
  });

  it("порожня відповідь — порожньо, і гейт тоді чесно вимикається", () => {
    expect(urlFromChat({})).toBeNull();
    expect(urlFromChat({ username: "", invite_link: null })).toBeNull();
  });
});
