import { describe, expect, it } from "bun:test";

import { appendBoot, bootReport, KEEP, parseBootLog, type Boot } from "./boot-log";

const T = Date.UTC(2026, 9, 20, 12, 0, 0);

describe("parseBootLog", () => {
  it("порожнє сховище — порожній журнал, а не виняток", () => {
    expect(parseBootLog(null)).toEqual([]);
    expect(parseBootLog("")).toEqual([]);
  });

  it("пошкоджений вміст не валить старт процесу", () => {
    // Впасти на старті через зламаний журнал гірше, ніж утратити історію.
    expect(parseBootLog("{не json")).toEqual([]);
    expect(parseBootLog('{"a":1}')).toEqual([]);
  });

  it("відкидає записи без часу й лишає решту", () => {
    const raw = JSON.stringify([{ sha: "a" }, { at: T, sha: "b" }, { at: "ні", sha: "c" }]);
    expect(parseBootLog(raw)).toEqual([{ at: T, sha: "b" }]);
  });

  it("запис без SHA лишається — час запуску сам собою цінний", () => {
    expect(parseBootLog(JSON.stringify([{ at: T }]))).toEqual([{ at: T, sha: "" }]);
  });

  it("журнал не росте нескінченно", () => {
    const many = Array.from({ length: KEEP + 8 }, (_, i) => ({ at: T + i * 1000, sha: "x" }));
    const out = parseBootLog(JSON.stringify(many));
    expect(out).toHaveLength(KEEP);
    expect(out[out.length - 1]!.at).toBe(T + (KEEP + 7) * 1000);
  });
});

describe("appendBoot", () => {
  it("дописує поточний запуск і тримає межу", () => {
    const prev: Boot[] = Array.from({ length: KEEP }, (_, i) => ({ at: T + i, sha: "old" }));
    const out = appendBoot(prev, { at: T + 10_000, sha: "new" });
    expect(out).toHaveLength(KEEP);
    expect(out[out.length - 1]).toEqual({ at: T + 10_000, sha: "new" });
  });
});

describe("bootReport — відповідь на «чому перезапускається»", () => {
  it("кожен запуск на новій збірці — це деплої, перезапусків немає", () => {
    const log: Boot[] = [
      { at: T, sha: "aaa" },
      { at: T + 3_600_000, sha: "bbb" },
      { at: T + 7_200_000, sha: "ccc" },
    ];
    expect(bootReport(log).sameBuildRestarts).toBe(0);
  });

  it("той самий SHA двічі — процес перезапустився сам", () => {
    const log: Boot[] = [
      { at: T, sha: "aaa" },
      { at: T + 600_000, sha: "aaa" },
    ];
    const r = bootReport(log);
    expect(r.sameBuildRestarts).toBe(1);
    expect(r.lastSameBuildAt).toBe(T + 600_000);
    expect(r.lastSameBuildLifetimeSec).toBe(600);
  });

  it("порожній SHA не вважається збігом", () => {
    /*
     * Якщо платформа версії не дала, ми НЕ знаємо, чи збірка та сама.
     * Порахувати це за падіння означало б вигадати діагноз із незнання.
     */
    const log: Boot[] = [
      { at: T, sha: "" },
      { at: T + 60_000, sha: "" },
    ];
    expect(bootReport(log).sameBuildRestarts).toBe(0);
  });

  it("час життя попереднього процесу відрізняє падіння від зупинки за простоєм", () => {
    const crashy: Boot[] = [
      { at: T, sha: "aaa" },
      { at: T + 40_000, sha: "aaa" },
    ];
    expect(bootReport(crashy).lastSameBuildLifetimeSec).toBe(40);
    const idle: Boot[] = [
      { at: T, sha: "aaa" },
      { at: T + 5 * 3_600_000, sha: "aaa" },
    ];
    expect(bootReport(idle).lastSameBuildLifetimeSec).toBe(18_000);
  });

  it("один запуск — ще нічого не сталося", () => {
    expect(bootReport([{ at: T, sha: "aaa" }])).toEqual({
      known: 1,
      sameBuildRestarts: 0,
      lastSameBuildAt: null,
      lastSameBuildLifetimeSec: null,
    });
  });
});
