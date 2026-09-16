import { describe, expect, it } from "bun:test";

import { channelLink, inviteLink, parseStartPayload, renderInvite } from "./referral";

describe("parseStartPayload", () => {
  it("код запрошення", () => {
    expect(parseStartPayload("r_ab12cd")).toEqual({ ref: "ab12cd", from: "ref" });
  });
  it("перехід із кнопки під постом каналу", () => {
    expect(parseStartPayload("ch")).toEqual({ ref: null, from: "channel" });
  });
  it("перехід із пересланої картки обстановки", () => {
    expect(parseStartPayload("sh")).toEqual({ ref: null, from: "share" });
    expect(parseStartPayload("share")).toEqual({ ref: null, from: "share" });
  });
  it("порожній /start — прямий захід", () => {
    expect(parseStartPayload("")).toEqual({ ref: null, from: "direct" });
  });
  it("незнайомий формат читається як прямий захід, а не як помилка", () => {
    // Посилання живуть довше за формати: старе посилання має вести в бота, а
    // не в повідомлення про помилку.
    expect(parseStartPayload("utm_source=twitter")).toEqual({ ref: null, from: "direct" });
  });
});

describe("посилання", () => {
  it("будується з імені бота без @", () => {
    expect(inviteLink("@Radar_UAbot", "abc123")).toBe("https://t.me/Radar_UAbot?start=r_abc123");
    expect(channelLink("Radar_UAbot")).toBe("https://t.me/Radar_UAbot?start=ch");
  });
  it("без імені бота — null, а не посилання в нікуди", () => {
    expect(inviteLink(undefined, "abc")).toBeNull();
    expect(channelLink("")).toBeNull();
  });
});

describe("renderInvite", () => {
  it("дає готовий до пересилання текст із посиланням", () => {
    const text = renderInvite("https://t.me/b?start=r_x", 0);
    expect(text).toContain("https://t.me/b?start=r_x");
    expect(text).toContain("ще ніхто не прийшов");
  });
  it("рахує людей за українськими правилами множини", () => {
    expect(renderInvite("https://t.me/b?start=r_x", 1)).toContain("1</b> людина");
    expect(renderInvite("https://t.me/b?start=r_x", 3)).toContain("3</b> людини");
    expect(renderInvite("https://t.me/b?start=r_x", 11)).toContain("11</b> людей");
  });
  it("без посилання чесно каже, що це налаштування розгортання", () => {
    expect(renderInvite(null, 5)).toContain("TELEGRAM_BOT_USERNAME");
  });
});
