import { describe, expect, it } from "bun:test";
import { verifyInitData } from "./telegram-initdata";

const TOKEN = "123456:TEST-bot-token";

/** Будує коректно підписаний initData тим самим алгоритмом, що й Telegram. */
async function signed(fields: Record<string, string>, token = TOKEN): Promise<string> {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
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
  const secret = await hmac(enc.encode("WebAppData"), token);
  const hash = Array.from(await hmac(secret, pairs.join("\n")))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}

describe("перевірка initData Telegram Mini App", () => {
  const now = 1_700_000_000_000;
  const fresh = () => String(Math.floor(now / 1000) - 10);

  it("приймає справжній підпис і повертає користувача", async () => {
    const data = await signed({
      auth_date: fresh(),
      user: JSON.stringify({ id: 8025267710, first_name: "S" }),
    });
    const res = await verifyInitData(data, TOKEN, 86_400, now);
    expect(res.ok).toBe(true);
    expect(res.user?.id).toBe(8025267710);
  });

  it("відхиляє підроблені дані: змінене поле ламає підпис", async () => {
    const data = await signed({ auth_date: fresh(), user: JSON.stringify({ id: 111 }) });
    // Хтось підмінює id на власника, не переписуючи hash.
    const tampered = data.replace("111", "8025267710");
    const res = await verifyInitData(tampered, TOKEN, 86_400, now);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signature/);
  });

  it("відхиляє підпис, зроблений чужим токеном", async () => {
    const data = await signed({ auth_date: fresh(), user: JSON.stringify({ id: 1 }) }, "999:OTHER");
    const res = await verifyInitData(data, TOKEN, 86_400, now);
    expect(res.ok).toBe(false);
  });

  it("відхиляє старий initData", async () => {
    const old = String(Math.floor(now / 1000) - 200_000);
    const data = await signed({ auth_date: old, user: JSON.stringify({ id: 1 }) });
    const res = await verifyInitData(data, TOKEN, 86_400, now);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/stale/);
  });

  it("без токена або даних не проходить", async () => {
    expect((await verifyInitData("", TOKEN)).ok).toBe(false);
    expect((await verifyInitData("auth_date=1&hash=x", "")).ok).toBe(false);
  });
});
