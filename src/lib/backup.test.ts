import { describe, expect, it } from "bun:test";

import {
  buildBackup,
  mergeCircles,
  mergeSubscribers,
  parseBackup,
  renderBackupNote,
  renderRestoreResult,
} from "./backup";
import type { Circle } from "./circle";
import { newSubscriber, type Subscriber } from "./subscribers";

function sub(chatId: number, patch: Partial<Subscriber> = {}): Subscriber {
  return { ...newSubscriber(chatId, "2026-01-01T00:00:00Z"), ...patch };
}

const circle: Circle = {
  code: "ABC234",
  name: "Родина",
  ownerChatId: 1,
  members: [1],
  createdAt: "2026-01-01T00:00:00Z",
};

describe("parseBackup", () => {
  it("читає власний файл", () => {
    const file = buildBackup([sub(1)], [circle], "2026-01-01T00:00:00Z");
    const back = parseBackup(JSON.stringify(file));
    expect(back?.subscribers).toHaveLength(1);
    expect(back?.circles).toHaveLength(1);
  });

  it("чужий файл не приймається за базу підписників", () => {
    // Мовчки прийняти сторонній JSON — це спосіб втратити базу замість
    // відновити її.
    expect(parseBackup("не json")).toBeNull();
    expect(parseBackup("{}")).toBeNull();
    expect(parseBackup('{"subscribers":"багато"}')).toBeNull();
    expect(parseBackup("null")).toBeNull();
  });

  it("сміттєві записи всередині відкидаються поштучно", () => {
    const back = parseBackup('{"subscribers":[{"chatId":1},{"нема":"id"}],"circles":[{}]}');
    expect(back?.subscribers).toHaveLength(1);
    expect(back?.circles).toHaveLength(0);
  });
});

describe("злиття", () => {
  it("архів заповнює прогалини", () => {
    const r = mergeSubscribers([], [sub(1), sub(2)]);
    expect(r.added).toBe(2);
    expect(r.merged).toHaveLength(2);
  });

  it("живий запис виграє конфлікт — відновлення не має бути другою аварією", () => {
    const live = sub(1, { radiusKm: 100 });
    const archived = sub(1, { radiusKm: 25 });
    const r = mergeSubscribers([live], [archived]);
    expect(r.added).toBe(0);
    expect(r.merged[0]!.radiusKm).toBe(100);
  });

  it("кола зливаються за тим самим правилом", () => {
    const r = mergeCircles(
      [circle],
      [
        { ...circle, name: "Старе" },
        { ...circle, code: "ZZZ999" },
      ],
    );
    expect(r.added).toBe(1);
    expect(r.merged.find((c) => c.code === "ABC234")!.name).toBe("Родина");
  });
});

describe("тексти", () => {
  it("копія на ефемерному сховищі каже, що з нею робити", () => {
    const file = buildBackup([sub(1, { point: { lat: 50, lon: 30, label: "дім" } })], [], "");
    const note = renderBackupNote(file, true);
    expect(note).toContain("з точкою: <b>1</b>");
    expect(note).toContain("поверніть цей файл боту");
  });

  it("на постійному томі зайвого не пишемо", () => {
    expect(renderBackupNote(buildBackup([sub(1)], [], ""), false)).not.toContain("поверніть");
  });

  it("відновлення без новизни не вдає роботи", () => {
    const empty = { merged: [], added: 0, kept: 3 };
    expect(renderRestoreResult(empty, empty)).toContain("нового в ньому немає");
  });

  it("відновлення каже, що живі записи не переписувались", () => {
    const r = renderRestoreResult(
      { merged: [], added: 5, kept: 2 },
      { merged: [], added: 0, kept: 0 },
    );
    expect(r).toContain("Додано підписників: <b>5</b>");
    expect(r).toContain("не переписувались");
  });
});

describe("копія не несе координат із точністю до будинку", () => {
  const sub = (lat: number, lon: number, places?: { lat: number; lon: number; title: string }[]) =>
    ({
      ...newSubscriber(1, "2026-01-01T00:00:00Z"),
      point: { lat, lon, label: "дім" },
      ...(places ? { places: places.map((p) => ({ ...p, addedAt: 0 })) } : {}),
    }) as Subscriber;

  it("точку огрублено до сітки близько кілометра", () => {
    /*
     * У файлі лежить домашня адреса кожного користувача, підписана словом
     * «дім» або «школа». У країні під обстрілами це перелік цілей, і він іде
     * в Telegram, де лишається назавжди. Ціна огрублення заміряна: зсув ≤0,66
     * км, тобто 13 секунд часу підльоту проти 205 секунд застою самих даних.
     */
    const file = buildBackup([sub(50.4501234, 30.5236789)], [], "2026-09-17T00:00:00Z");
    const p = file.subscribers[0]!.point!;
    expect(p.lat).toBeCloseTo(50.45, 5);
    expect(p.lon).toBeCloseTo(30.52, 5);
  });

  it("огрублення менше за кілометр — тобто функція не страждає", () => {
    const file = buildBackup([sub(49.9876543, 36.2345678)], [], "2026-09-17T00:00:00Z");
    const p = file.subscribers[0]!.point!;
    const dLatKm = Math.abs(p.lat - 49.9876543) * 111.32;
    const dLonKm = Math.abs(p.lon - 36.2345678) * 111.32 * Math.cos((49.99 * Math.PI) / 180);
    expect(Math.hypot(dLatKm, dLonKm)).toBeLessThan(1);
  });

  it("мої місця огрублено так само — саме вони найчутливіші", () => {
    // «Школа» з точністю до будинку — найгірше, що може бути в цьому файлі.
    const file = buildBackup(
      [sub(50.45, 30.52, [{ lat: 50.4512345, lon: 30.5298765, title: "школа" }])],
      [],
      "2026-09-17T00:00:00Z",
    );
    const place = file.subscribers[0]!.places![0]!;
    expect(place.lat).toBeCloseTo(50.45, 5);
    expect(place.title).toBe("школа");
  });

  it("повторне збереження не зсуває точку далі", () => {
    // Округлення до сталої сітки ідемпотентне: цикл «відновив → зберіг» не має
    // відводити людину від її дому з кожним разом.
    const once = buildBackup([sub(50.4567, 30.5234)], [], "t");
    const twice = buildBackup(once.subscribers, [], "t");
    expect(twice.subscribers[0]!.point).toEqual(once.subscribers[0]!.point);
  });

  it("решта полів не чіпається", () => {
    const file = buildBackup([sub(50.45, 30.52)], [], "2026-09-17T00:00:00Z");
    expect(file.subscribers[0]!.chatId).toBe(1);
    expect(file.subscribers[0]!.point!.label).toBe("дім");
  });
});
