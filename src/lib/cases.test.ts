import { describe, expect, it } from "bun:test";

import {
  isPinned,
  platformEntityId,
  summarizeCase,
  validateNote,
  validateTitle,
  type AnalystCase,
} from "./cases";

describe("validateTitle", () => {
  it("стискає пробіли й приймає звичайну назву", () => {
    expect(validateTitle("  Підстанція   Північна  ")).toEqual({
      ok: true,
      value: "Підстанція Північна",
    });
  });

  it("відхиляє порожню назву", () => {
    // Справа без назви за тиждень невідрізненна від будь-якої іншої, а
    // перейменувати її платформа не дає.
    expect(validateTitle("   ").ok).toBe(false);
    expect(validateTitle("").error).toBeDefined();
  });

  it("відхиляє надто довгу назву", () => {
    expect(validateTitle("а".repeat(200)).ok).toBe(false);
  });
});

describe("validateNote", () => {
  it("приймає змістовну нотатку", () => {
    expect(validateNote(" перевірити живлення ")).toEqual({
      ok: true,
      value: "перевірити живлення",
    });
  });

  it("відхиляє порожню й завелику", () => {
    expect(validateNote("  ").ok).toBe(false);
    expect(validateNote("я".repeat(3000)).ok).toBe(false);
  });
});

describe("summarizeCase", () => {
  const base: AnalystCase = {
    id: "c1",
    title: "Справа",
    clearance: 1,
    createdAt: "2026-09-10T00:00:00.000Z",
  };

  it("рахує всі види записів разом", () => {
    const s = summarizeCase({
      ...base,
      notes: [{ text: "а", at: "x" }],
      findings: [{ summary: "б", attachedAt: "x" }],
      pinnedEntityIds: ["e1", "e2"],
    });
    expect(s).toMatchObject({ entries: 4, notes: 1, findings: 1, pinned: 2 });
  });

  it("порожня справа так і називається порожньою", () => {
    expect(summarizeCase(base).entries).toBe(0);
  });
});

describe("isPinned", () => {
  it("розпізнає вже приколотий обʼєкт", () => {
    // Інакше повторний клік мав би вигляд дії, яка нічого не робить.
    const item: AnalystCase = {
      id: "c",
      title: "т",
      clearance: 0,
      createdAt: "x",
      pinnedEntityIds: ["a"],
    };
    expect(isPinned(item, "a")).toBe(true);
    expect(isPinned(item, "b")).toBe(false);
    expect(isPinned({ ...item, pinnedEntityIds: undefined as never }, "a")).toBe(false);
  });
});

describe("platformEntityId", () => {
  it("перетворює id консолі на id платформи", () => {
    // Консоль знає обʼєкт як `way/123`, платформа — після slugify. Без цього
    // «приколоти» вказувало б у порожнечу.
    expect(platformEntityId("way/123")).toBe("infraua_facility_way123");
  });

  it("зберігає українські літери", () => {
    // Той самий клас помилки, що вже ламав ключі операторів.
    expect(platformEntityId("Київ/1")).toBe("infraua_facility_київ1");
  });

  it("не втрачає підкреслення й дефіси", () => {
    expect(platformEntityId("node_9-b")).toBe("infraua_facility_node_9-b");
  });
});

describe("контракт із платформою", () => {
  it("будує id тим самим правилом, що й платформа", async () => {
    /*
     * Правило живе в одному файлі — `platform/core/ingestion/slug.ts`, — і
     * обидві половини продукту читають саме його. Тест перевіряє, що звʼязок
     * не розірвано: якби консоль повернулася до власної копії, справи почали б
     * збиратися порожніми, і помітили б це не одразу.
     *
     * Файл навмисно без жодного імпорту: інакше він тягнув би за собою код
     * платформи в суворішу перевірку консолі.
     */
    const { slugify } = await import("../../platform/core/ingestion/slug");
    for (const id of ["way/123", "node/9", "Київ/1", "node_9-b", "seed/hospital/3", "ГЕС №2"]) {
      expect(platformEntityId(id)).toBe(slugify(`infraua_facility_${id}`));
    }
  });
});
