import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeCircleCode } from "./circle";
import {
  allSubscribers,
  createCircle,
  creditInvite,
  dataDirSource,
  getCircle,
  joinCircle,
  leaveCircle,
  ensureSubscriber,
  flushNow,
  isDurable,
  probeWritable,
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

describe("негайний запис", () => {
  it("поява підписника не чекає на відкладений запис", async () => {
    // Вікно між дотиком і записом стирав редеплой: людина задала точку, за
    // хвилину бот про неї не знав. `/stats` показував «Усього: 0» посеред
    // активного користування.
    await ensureSubscriber(1, "2026-01-01T00:00:00Z");
    resetStoreForTests();
    expect((await allSubscribers()).map((s) => s.chatId)).toEqual([1]);
  });

  it("нова точка пишеться негайно, без очікування", async () => {
    const { sub } = await ensureSubscriber(2, "2026-01-01T00:00:00Z");
    await putSubscriber({ ...sub, point: { lat: 50, lon: 30, label: "дім" } }, true);
    resetStoreForTests();
    expect((await allSubscribers())[0]?.point?.label).toBe("дім");
  });

  it("службові зміни лишаються відкладеними — інакше обхід переписував би файл сотні разів", async () => {
    const { sub } = await ensureSubscriber(3, "2026-01-01T00:00:00Z");
    await putSubscriber({ ...sub, lastAlertAt: 123 });
    resetStoreForTests();
    // Створення вже записалось негайно, а службова зміна — ще ні.
    expect((await allSubscribers())[0]?.lastAlertAt).toBe(0);
  });
});

describe("де лежить сховище", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env["BOT_DATA_DIR"] = saved["BOT_DATA_DIR"];
    delete process.env["RAILWAY_VOLUME_MOUNT_PATH"];
    delete process.env["PLATFORM_DATA_DIR"];
  });

  it("том Railway підхоплюється САМ — власнику не треба задавати змінну", async () => {
    // Railway виставляє RAILWAY_VOLUME_MOUNT_PATH автоматично, щойно том
    // підключено. Вимога задати ще й BOT_DATA_DIR була тим зайвим кроком,
    // через який том міг бути, а підписники все одно зникали.
    delete process.env["BOT_DATA_DIR"];
    process.env["RAILWAY_VOLUME_MOUNT_PATH"] = join(dir, "vol");
    expect(dataDirSource()).toBe("RAILWAY_VOLUME_MOUNT_PATH");
    expect(isDurable()).toBe(true);
    resetStoreForTests();
    await ensureSubscriber(77, "2026-01-01T00:00:00Z");
    resetStoreForTests();
    expect((await allSubscribers()).map((s) => s.chatId)).toEqual([77]);
  });

  it("явний BOT_DATA_DIR перекриває автовизначення", () => {
    process.env["BOT_DATA_DIR"] = "/explicit";
    process.env["RAILWAY_VOLUME_MOUNT_PATH"] = "/volume";
    expect(dataDirSource()).toBe("BOT_DATA_DIR");
  });

  it("без жодного тому сховище чесно зветься ефемерним", () => {
    delete process.env["BOT_DATA_DIR"];
    expect(dataDirSource()).toBe("default");
    expect(isDurable()).toBe(false);
  });

  it("запис МІРЯЄТЬСЯ, а не виводиться з наявності змінної", async () => {
    // Том можна підключити не в ту теку або лише для читання — конфігурація
    // виглядатиме правильною, поки дані зникають.
    process.env["BOT_DATA_DIR"] = join(dir, "probe-ok");
    expect((await probeWritable()).ok).toBe(true);
    process.env["BOT_DATA_DIR"] = "/proc/nonexistent-for-sure/nested";
    const bad = await probeWritable();
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});
