import { describe, expect, it } from "bun:test";

import { roleOfSource } from "./osint-sources";

describe("перелік каналів проти того, що реально пише", () => {
  /**
   * Канали, заміряні в живій видачі другого агрегатора (detoyshahed,
   * 2026-09-17, 222 повідомлення), із кількістю повідомлень від кожного.
   *
   * Це не побажання, а зріз реальності. До цього заміру пʼятьох із них у
   * переліку не було, і 176 повідомлень із 222 (79%) приходили від каналів,
   * яких код не знав, — зокрема найактивнішого `chyste_nebo` з 80.
   */
  const MEASURED: [channel: string, messages: number][] = [
    ["chyste_nebo", 80],
    ["UkraineAlarmSignal", 48],
    ["radar_top_ua", 28],
    ["Kyiv AirDefense 🌇", 21],
    ["chyste_nebochernigv", 20],
    ["eRadarrua", 11],
    ["Ukrainian_Intelligence", 7],
    ["kudy_letyt", 5],
    ["kpszsu", 1],
    ["kyivradar", 1],
  ];

  it("жоден заміряний канал не лишається невідомим", () => {
    // Невідома роль дає reliability «F» і вимикає knownSource у verifyThreat —
    // тобто ми знецінювали дані, на яких самі ж працюємо.
    const unknown = MEASURED.filter(([ch]) => roleOfSource(ch) === "unknown").map(([ch]) => ch);
    expect(unknown).toEqual([]);
  });

  it("назва з пробілом і емодзі теж зіставляється", () => {
    // `Kyiv AirDefense 🌇` приходить саме так; зіставлення йде за обрізаним
    // нижнім регістром, і це легко зламати «причісуванням» переліку.
    expect(roleOfSource("Kyiv AirDefense 🌇")).not.toBe("unknown");
    expect(roleOfSource("  kyiv airdefense 🌇  ")).not.toBe("unknown");
  });

  it("канал поза переліком лишається саме НЕВІДОМИМ, а не поганим", () => {
    // Різниця принципова: «не знаємо» і «погане джерело» — різні твердження.
    expect(roleOfSource("якийсь_новий_канал")).toBe("unknown");
  });
});
