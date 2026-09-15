import { describe, expect, it } from "bun:test";

import {
  budgetFor,
  deliver,
  type Envelope,
  orderQueue,
  Priority,
  type SendOutcome,
  TELEGRAM_BROADCAST_PER_SEC,
  timeToReachMs,
} from "./delivery";

function env(chatId: number, priority: Priority, expiresAt = 1e15): Envelope<string> {
  return { chatId, priority, expiresAt, payload: `msg-${chatId}` };
}

const noSleep = async () => {};
const ok: SendOutcome = { ok: true, status: 200 };

describe("порядок черги", () => {
  it("в укриття йде поперед «пильнуйте», хоч би як лежав масив", () => {
    // Раніше порядок визначався тим, у якому порядку підписники лежали у
    // файлі: хто записався пізніше, той і попереджався пізніше.
    const out = orderQueue([
      env(1, Priority.Watch),
      env(2, Priority.Shelter),
      env(3, Priority.Routine),
      env(4, Priority.Attention),
    ]);
    expect(out.map((e) => e.chatId)).toEqual([2, 4, 1, 3]);
  });

  it("серед рівних першим іде той, кому лишилось менше часу", () => {
    const out = orderQueue([env(1, Priority.Shelter, 5000), env(2, Priority.Shelter, 1000)]);
    expect(out.map((e) => e.chatId)).toEqual([2, 1]);
  });
});

describe("арифметика стелі", () => {
  it("бюджет — це швидкість на час, без запасу «на око»", () => {
    expect(budgetFor(60_000, 30)).toBe(1800);
    expect(budgetFor(0, 30)).toBe(0);
  });

  it("сто тисяч людей на безкоштовній стелі — майже година", () => {
    // Документоване число Telegram: ~30/с. Шахед за 55 хвилин долає 165 км.
    const ms = timeToReachMs(100_000, TELEGRAM_BROADCAST_PER_SEC);
    expect(Math.round(ms / 60_000)).toBe(56);
  });
});

describe("deliver", () => {
  it("надсилає в межах бюджету, а хвіст рахує як втрату, а не мовчить", () => {
    return deliver(
      [env(1, Priority.Shelter), env(2, Priority.Shelter), env(3, Priority.Watch)],
      async () => ok,
      { perSec: 30, windowMs: 100, sleep: noSleep },
    ).then((r) => {
      // 100 мс × 30/с = 3 повідомлення… округлення вниз дає 3.
      expect(r.sent).toBe(3);
      expect(r.dropped).toBe(0);
    });
  });

  it("коли бюджету бракує, ріжеться хвіст із найнижчим пріоритетом", async () => {
    const seen: number[] = [];
    const r = await deliver(
      [env(1, Priority.Watch), env(2, Priority.Shelter), env(3, Priority.Attention)],
      async (e) => {
        seen.push(e.chatId);
        return ok;
      },
      { perSec: 30, windowMs: 34, sleep: noSleep },
    );
    expect(seen).toEqual([2]); // укриття
    expect(r.dropped).toBe(2);
  });

  it("прострочене не надсилається взагалі", async () => {
    // «~4 хв до вас» через двадцять хвилин — це не запізніле попередження, а
    // неправда про час.
    let calls = 0;
    const r = await deliver(
      [env(1, Priority.Shelter, 500)],
      async () => {
        calls += 1;
        return ok;
      },
      { perSec: 30, windowMs: 60_000, sleep: noSleep, now: () => 1000 },
    );
    expect(calls).toBe(0);
    expect(r.expired).toBe(1);
    expect(r.sent).toBe(0);
  });

  it("429 — чекаємо рівно стільки, скільки сказано, і зупиняємо всю чергу", async () => {
    const waits: number[] = [];
    let first = true;
    const r = await deliver(
      [env(1, Priority.Shelter)],
      async () => {
        if (first) {
          first = false;
          return { ok: false, status: 429, retryAfterSec: 7 };
        }
        return ok;
      },
      { perSec: 30, windowMs: 60_000, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toContain(7000);
    expect(r.throttled).toBe(1);
    expect(r.sent).toBe(1);
  });

  it("429 без retry_after не перетворюється на нульову паузу", async () => {
    const waits: number[] = [];
    await deliver([env(1, Priority.Shelter)], async () => ({ ok: false, status: 429 }), {
      perSec: 30,
      windowMs: 60_000,
      sleep: async (ms) => void waits.push(ms),
      maxAttempts: 1,
    });
    expect(waits.some((w) => w >= 1000)).toBe(true);
  });

  it("заблокований бот не з'їдає бюджет повторами", async () => {
    let calls = 0;
    const r = await deliver(
      [env(77, Priority.Shelter)],
      async () => {
        calls += 1;
        return { ok: false, status: 403 };
      },
      { perSec: 30, windowMs: 60_000, sleep: noSleep, maxAttempts: 3 },
    );
    expect(calls).toBe(1);
    expect(r.blocked).toEqual([77]);
  });

  it("тимчасова відмова пробується ще раз, а далі рахується як невдача", async () => {
    let calls = 0;
    const r = await deliver(
      [env(1, Priority.Shelter)],
      async () => {
        calls += 1;
        return { ok: false, status: 500 };
      },
      { perSec: 30, windowMs: 60_000, sleep: noSleep, maxAttempts: 2 },
    );
    expect(calls).toBe(2);
    expect(r.failed).toBe(1);
  });

  it("порожня черга — порожній звіт, без винятків", async () => {
    const r = await deliver([], async () => ok, { sleep: noSleep });
    expect(r).toEqual({ sent: 0, expired: 0, dropped: 0, blocked: [], throttled: 0, failed: 0 });
  });
});
