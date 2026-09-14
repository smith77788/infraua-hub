import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import {
  countryCard,
  inlineResults,
  matchOblast,
  oblastCard,
  parseInlineQuery,
} from "./bot-inline";

function threat(p: Partial<Threat>): Threat {
  return {
    id: Math.random().toString(36).slice(2),
    name: "Ціль",
    lat: 49.99,
    lon: 36.23,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

describe("parseInlineQuery", () => {
  it("дістає запит і його ідентифікатор", () => {
    const q = parseInlineQuery({ inline_query: { id: "7", from: { id: 1 }, query: " Харків " } });
    expect(q).toEqual({ id: "7", userId: 1, query: "Харків" });
  });
  it("звичайне повідомлення — не inline", () => {
    expect(parseInlineQuery({ message: { text: "/status" } })).toBeNull();
  });
});

describe("matchOblast", () => {
  it("знаходить за незакінченим набором — у чаті дописувати ніхто не буде", () => {
    expect(matchOblast("харк")?.name).toBe("Харківщина");
  });
  it("знаходить за офіційною назвою", () => {
    expect(matchOblast("Харківська область")?.name).toBe("Харківщина");
  });
  it("одна літера не рахується — інакше збіг буде з чим завгодно", () => {
    expect(matchOblast("х")).toBeNull();
  });
});

describe("картки", () => {
  it("чисте небо називається чистим, але з межею OSINT", () => {
    const card = countryCard([]);
    expect(card.text).toContain("не фіксуємо");
    expect(card.text).toContain("OSINT");
  });

  it("картка країни рахує ОБʼЄКТИ і перелічує області", () => {
    const card = countryCard([threat({}), threat({}), threat({ lat: 50.91, lon: 34.8 })]);
    expect(card.text).toContain("У небі зараз: 3");
    expect(card.text).toContain("Харківщина");
  });

  it("картка області бере лише те, що поруч із нею", () => {
    const card = oblastCard([threat({}), threat({ lat: 46.48, lon: 30.73 })], {
      name: "Харківщина",
      lat: 49.99,
      lon: 36.23,
    });
    expect(card.text).toContain("Харківщина: 1 у небі");
  });
});

describe("inlineResults", () => {
  it("впізнана область іде першою — її й надішлють, не читаючи списку", () => {
    const out = inlineResults([threat({})], "харків", "https://t.me/bot?start=ch");
    expect(out).toHaveLength(2);
    expect(out[0]!.title).toContain("Харківщина");
    expect(out[1]!.id).toBe("country");
  });

  it("кнопка «перевірити свою адресу» їде з кожною карткою", () => {
    const out = inlineResults([threat({})], "", "https://t.me/bot?start=ch");
    expect(out[0]!.reply_markup?.inline_keyboard[0]![0]!.url).toBe("https://t.me/bot?start=ch");
  });

  it("без відомого імені бота картка все одно надсилається, просто без кнопки", () => {
    const out = inlineResults([threat({})], "", null);
    expect(out[0]!.reply_markup).toBeUndefined();
    expect(out[0]!.input_message_content.parse_mode).toBe("HTML");
  });
});
