import { describe, expect, it } from "bun:test";

import {
  OK_FRESH_MS,
  randomCircleCode,
  normalizeCircleCode,
  renderCircle,
  renderPeerOk,
  type Circle,
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
      expect(randomCircleCode()).not.toMatch(/[01OIL]/);
      expect(randomCircleCode()).toHaveLength(6);
    }
  });

  it("НЕ стабільний — саме сталість і була вразливістю", () => {
    /*
     * Тест перевіряв, що код той самий для того самого джерела. Джерелом був
     * `ownerChatId`, а функція лежить у відкритому репозиторії — тобто код
     * кола рахувався з несекретного значення. Приєднання ж нікого не питає.
     * Ланцюг був повний: знаєш ідентифікатор → рахуєш код → тихо входиш →
     * бачиш імена рідних і сповіщення про небезпеку над ними.
     *
     * Тому сталість тут не властивість, яку треба берегти, а те, що треба
     * було прибрати.
     */
    const codes = new Set(Array.from({ length: 50 }, () => randomCircleCode()));
    expect(codes.size).toBeGreaterThan(45);
  });

  it("не має перекосу за модулем — 256 не ділиться на 31 націло", () => {
    /*
     * Наївне `byte % 31` зробило б перші символи абетки частішими приблизно в
     * 1,15 раза. Для коду, який боронить коло родини, це звуження простору
     * перебору, тож байти поза межею відкидаються.
     */
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      for (const ch of randomCircleCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(31);
    const values = [...counts.values()];
    const min = Math.min(...values);
    const max = Math.max(...values);
    // На 24 000 символах рівномірний розподіл дає ~774 на символ; допуск
    // широкий навмисно, бо ловимо систематичний перекіс, а не випадковість.
    expect(max / min).toBeLessThan(1.35);
  });

  it("бере байти з переданого джерела — щоб властивості можна було перевірити", () => {
    // Перші байти нижчі за межу відкидання, тож мапляться передбачувано.
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(randomCircleCode(() => bytes)).toBe("ABCDEF");
  });

  it("байт поза межею відкидається, а не зсуває абетку", () => {
    // 248..255 поза межею (248 = 8×31): якби їх не відкидали, «A» траплялась
    // би частіше за решту.
    const bytes = new Uint8Array([250, 0, 251, 1, 252, 2, 253, 3, 254, 4, 255, 5]);
    expect(randomCircleCode(() => bytes)).toBe("ABCDEF");
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

/*
 * Повідомлення кола шлються з `parse_mode: "HTML"`, а імена — і своє, і назву
 * кола — людина задає сама. Без екранування це давало три поразки, і
 * найгірша тиха: зламана розмітка змушує Telegram відхилити повідомлення
 * ЦІЛКОМ, тобто «я в порядку» просто не доходить до рідних — а саме заради
 * цього рядка коло й існує.
 */
describe("коло: усе від людини йде через екранування", () => {
  it("чуже посилання не стає посиланням", () => {
    const out = renderPeerOk('<a href="https://phish.example">Мама</a>', "Родина");
    expect(out).not.toContain("<a href");
    expect(out).toContain("&lt;a href");
  });

  it("підроблений текст від імені бота не проходить", () => {
    const out = renderPeerOk("Мама", "Родина</b> ⚠️ <b>УВАГА");
    // Після екранування в рядку лишаються ЛИШЕ наші власні теги.
    expect(out.match(/<\/?b>/g) ?? []).toHaveLength(2);
  });

  it("зламана розмітка не ламає повідомлення", () => {
    // `<b` без закриття відхиляється Telegram разом з усім повідомленням.
    const out = renderPeerOk("<b", "Родина");
    expect(out).toContain("&lt;b");
    expect(out.match(/<\/?b>/g) ?? []).toHaveLength(2);
  });

  it("перелік кола теж екранує імена й назву", () => {
    const circle = { code: "ABC234", name: "<i>Родина</i>", ownerChatId: 1, members: [1] };
    const out = renderCircle(
      circle as never,
      [{ chatId: 1, name: "<script>x</script>", okAt: null }],
      Date.now(),
    );
    expect(out).not.toContain("<i>Родина</i>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("звичайне імʼя лишається звичайним", () => {
    expect(renderPeerOk("Мама", "Родина")).toBe("✅ <b>Мама</b> у порядку · Родина");
  });
});
