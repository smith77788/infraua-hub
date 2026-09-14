import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeCircleCode } from "./circle";
import {
  allSubscribers,
  createCircle,
  creditInvite,
  getCircle,
  joinCircle,
  leaveCircle,
  ensureSubscriber,
  flushNow,
  isDurable,
  putSubscriber,
  resetStoreForTests,
  stats,
} from "./subscriber-store";

const dir = await mkdtemp(join(tmpdir(), "radar-subs-"));

// Кожен тест — власна тека: інакше файл, записаний попереднім, дочитується
// наступним, і перевірка лічильників меряє суму тестів, а не поведінку коду.
let caseNo = 0;
beforeEach(() => {
  caseNo += 1;
  process.env["BOT_DATA_DIR"] = join(dir, `case-${caseNo}`);
  resetStoreForTests();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("сховище підписників", () => {
  it("підписник переживає перезапуск процесу", async () => {
    const { sub, created } = await ensureSubscriber(101, "2026-01-01T00:00:00Z");
    expect(created).toBe(true);
    await putSubscriber({ ...sub, point: { lat: 50, lon: 30, label: "дім" }, radiusKm: 75 });
    await flushNow();

    // Саме те, що відбувається при редеплої: памʼять процесу порожня, файл — ні.
    resetStoreForTests();
    const back = (await allSubscribers()).find((s) => s.chatId === 101);
    expect(back?.point?.label).toBe("дім");
    expect(back?.radiusKm).toBe(75);
  });

  it("той самий chatId не заводиться двічі", async () => {
    await ensureSubscriber(202, "2026-01-01T00:00:00Z");
    const again = await ensureSubscriber(202, "2026-01-02T00:00:00Z");
    expect(again.created).toBe(false);
    expect(again.sub.joinedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("запрошення зараховується власнику коду", async () => {
    const { sub } = await ensureSubscriber(303, "2026-01-01T00:00:00Z");
    await ensureSubscriber(404, "2026-01-01T00:00:00Z", sub.code);
    expect(await creditInvite(sub.code, 404)).toBe(true);
    const owner = (await allSubscribers()).find((s) => s.chatId === 303);
    expect(owner?.invited).toBe(1);
  });

  it("свій власний код не зараховується — інакше лічильник накручують собі", async () => {
    const { sub } = await ensureSubscriber(505, "2026-01-01T00:00:00Z");
    expect(await creditInvite(sub.code, 505)).toBe(false);
  });

  it("невідомий код нічого не ламає", async () => {
    expect(await creditInvite("nosuch", 606)).toBe(false);
  });

  it("stats бачить постійний том і рахує лише тих, хто справді отримує сповіщення", async () => {
    const { sub } = await ensureSubscriber(707, "2026-01-01T00:00:00Z");
    await putSubscriber({ ...sub, point: { lat: 50, lon: 30, label: "дім" }, muted: true });
    await ensureSubscriber(808, "2026-01-01T00:00:00Z"); // без точки
    const st = await stats();
    expect(isDurable()).toBe(true);
    expect(st.durable).toBe(true);
    expect(st.total).toBe(2);
    expect(st.withPoint).toBe(1);
    expect(st.active).toBe(0);
  });
});

describe("кола", () => {
  it("коло переживає перезапуск разом із підписниками", async () => {
    const circle = await createCircle("Родина", 1, makeCircleCode);
    await joinCircle(circle.code, 2);
    await flushNow();

    resetStoreForTests();
    const back = await getCircle(circle.code);
    expect(back?.name).toBe("Родина");
    expect(back?.members).toEqual([1, 2]);
  });

  it("код кола не видається двом різним колам", async () => {
    // Колізія тут означала б, що чужа людина мовчки бачить відмітки рідних.
    const a = await createCircle("Перше", 1, makeCircleCode);
    const b = await createCircle("Друге", 1, makeCircleCode);
    expect(a.code).not.toBe(b.code);
  });

  it("повторний вступ не дублює учасника", async () => {
    const circle = await createCircle("Родина", 1, makeCircleCode);
    await joinCircle(circle.code, 2);
    const again = await joinCircle(circle.code, 2);
    expect(again?.members).toEqual([1, 2]);
  });

  it("вихід прибирає зі старого кола, а не лишає відмітку чужим", async () => {
    const circle = await createCircle("Родина", 1, makeCircleCode);
    await joinCircle(circle.code, 2);
    await leaveCircle(circle.code, 2);
    expect((await getCircle(circle.code))?.members).toEqual([1]);
  });

  it("порожнє коло зникає — воно вже нічиє", async () => {
    const circle = await createCircle("Родина", 1, makeCircleCode);
    await leaveCircle(circle.code, 1);
    expect(await getCircle(circle.code)).toBeUndefined();
  });

  it("невідомий код не створює кола на льоту", async () => {
    expect(await joinCircle("ZZZZZZ", 9)).toBeNull();
  });
});
