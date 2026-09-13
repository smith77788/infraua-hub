import { afterEach, describe, expect, it } from "bun:test";
import {
  INFRA_LAYERS_FLAG,
  infraLayersEnabled,
  infraLayersOff,
  infraLayersPermitted,
} from "./infra-gate";

const TOKEN = "123456:TEST-bot-token";
const OWNER = 8025267710;

/** Будує коректно підписаний initData тим самим алгоритмом, що й Telegram. */
async function signed(fields: Record<string, string>, token = TOKEN): Promise<string> {
  const enc = new TextEncoder();
  const hmac = async (key: ArrayBuffer | Uint8Array, msg: string) => {
    const k = await crypto.subtle.importKey(
      "raw",
      key as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  };
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = await hmac(enc.encode("WebAppData"), token);
  const hash = Array.from(await hmac(secret, pairs.join("\n")))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}

/** Свіжий підпис із заданим id користувача. */
function ownerInitData(id: number): Promise<string> {
  return signed({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id }),
  });
}

afterEach(() => {
  delete process.env[INFRA_LAYERS_FLAG];
  delete process.env["TELEGRAM_BOT_TOKEN"];
  delete process.env["TELEGRAM_OWNER_ID"];
});

describe("вимикач шарів критичної інфраструктури", () => {
  it("вимкнений, поки розгортання не сказало інакше", () => {
    // Головна властивість: розгортання, яке про вимикач не знає, нічого не
    // віддає. Протилежне усталене значення означало б, що шари публікує той,
    // хто про них не думав.
    expect(infraLayersPermitted()).toBe(false);
  });

  it("вмикається рівно одним значенням, а не будь-чим правдоподібним", () => {
    for (const value of ["yes", "true", "1", "ON", "on ", ""]) {
      process.env[INFRA_LAYERS_FLAG] = value;
      expect(infraLayersPermitted()).toBe(false);
    }
    process.env[INFRA_LAYERS_FLAG] = "on";
    expect(infraLayersPermitted()).toBe(true);
  });
});

describe("шари віддаються лише власникові", () => {
  it("без підпису — не віддаються (публіка нічого не бачить)", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = TOKEN;
    process.env["TELEGRAM_OWNER_ID"] = String(OWNER);
    expect(await infraLayersEnabled()).toBe(false);
    expect(await infraLayersEnabled("")).toBe(false);
  });

  it("справжній підпис власника — віддаються", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = TOKEN;
    process.env["TELEGRAM_OWNER_ID"] = String(OWNER);
    expect(await infraLayersEnabled(await ownerInitData(OWNER))).toBe(true);
  });

  it("справжній підпис, але НЕ власника — не віддаються", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = TOKEN;
    process.env["TELEGRAM_OWNER_ID"] = String(OWNER);
    expect(await infraLayersEnabled(await ownerInitData(OWNER + 1))).toBe(false);
  });

  it("підпис чужим токеном — не віддаються (підробити не можна)", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = TOKEN;
    process.env["TELEGRAM_OWNER_ID"] = String(OWNER);
    const forged = await signed(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: OWNER }) },
      "999:OTHER-token",
    );
    expect(await infraLayersEnabled(forged)).toBe(false);
  });

  it("без TELEGRAM_OWNER_ID нема кому віддавати — навіть за валідним підписом", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = TOKEN;
    expect(await infraLayersEnabled(await ownerInitData(OWNER))).toBe(false);
  });

  it("локальна розробка: INFRA_LAYERS=on віддає без Telegram", async () => {
    process.env[INFRA_LAYERS_FLAG] = "on";
    expect(await infraLayersEnabled()).toBe(true);
  });
});

describe("як консоль читає стан із відповіді", () => {
  it("вважає вимкненим, поки відповіді немає", () => {
    // Сторінка збирається на сервері раніше, ніж запит відповість. Якби
    // невідоме значення читалося як «увімкнено», був би кадр із намальованою
    // обстановкою шарів.
    expect(infraLayersOff(undefined)).toBe(true);
    expect(infraLayersOff({})).toBe(true);
  });

  it("вмикається назад лише на явне `false`", () => {
    // Це те, що ламалося: увімкнений шлях лишав поле порожнім, тож був
    // невідрізненний від «ще не відповіли», і вимикач не вмикався назад.
    expect(infraLayersOff({ disabled: false })).toBe(false);
    expect(infraLayersOff({ disabled: true })).toBe(true);
  });
});
