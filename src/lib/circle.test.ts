import { describe, expect, it } from "bun:test";

import {
  type Circle,
  makeCircleCode,
  normalizeCircleCode,
  OK_FRESH_MS,
  renderCircle,
  renderPeerOk,
} from "./circle";

const circle: Circle = {
  code: "ABC234",
  name: "Родина",
  ownerChatId: 1,
  members: [1, 2, 3],
  createdAt: "2026-01-01T00:00:00Z",
};

describe("код кола", () => {
  it("не містить символів, які плутають на слух", () => {
    // Код диктують у телефон: «нуль» і «О» нерозрізненні, а помилка означає,
    // що людина мовчки не потрапить у коло рідних.
    for (let seed = 1; seed < 200; seed++) {
      expect(makeCircleCode(seed)).not.toMatch(/[01OIL]/);
      expect(makeCircleCode(seed)).toHaveLength(6);
    }
  });

  it("стабільний для того самого джерела", () => {
    expect(makeCircleCode(42)).toBe(makeCircleCode(42));
  });

  it("прощає регістр і продиктовані «о» та «і»", () => {
    expect(normalizeCircleCode(" abc234 ")).toBe("ABC234");
    expect(normalizeCircleCode("qbc234")).toBe("QBC234");
    expect(normalizeCircleCode("короткий")).toBeNull();
    expect(normalizeCircleCode("")).toBeNull();
  });
});

describe("renderCircle", () => {
  const now = 10_000_000;

  it("ті, кого ще немає, стоять першими — заради них і відкривають екран", () => {
    const text = renderCircle(
      circle,
      [
        { chatId: 1, name: "Мама", okAt: now - 60_000 },
        { chatId: 2, name: "Тато", okAt: null },
      ],
      now,
    );
    expect(text.indexOf("Мама")).toBeLessThan(text.indexOf("Тато"));
    expect(text).toContain("Відмітились: <b>1</b> з <b>2</b>");
  });

  it("мовчання НЕ тлумачиться як біда — і це сказано прямо", () => {
    // Найважливіший рядок екрана: без нього порожній квадратик читається як
    // «з людиною щось сталося».
    const text = renderCircle(circle, [{ chatId: 2, name: "Тато", okAt: null }], now);
    expect(text).toContain("Це не сигнал про біду");
  });

  it("стара відмітка не рахується свіжою", () => {
    const text = renderCircle(
      circle,
      [{ chatId: 1, name: "Мама", okAt: now - OK_FRESH_MS - 1000 }],
      now,
    );
    expect(text).toContain("Відмітились: <b>0</b> з <b>1</b>");
  });

  it("координат немає ніде — коло знімає тривогу, а не показує місце", () => {
    const text = renderCircle(circle, [{ chatId: 1, name: "Мама", okAt: now }], now);
    expect(text).not.toMatch(/\d+\.\d{3,}/);
  });
});

describe("renderPeerOk", () => {
  it("один рядок — це сповіщення, а не звіт", () => {
    expect(renderPeerOk("Мама", "Родина").split("\n")).toHaveLength(1);
  });
});
