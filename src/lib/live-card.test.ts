import { describe, expect, it } from "bun:test";
import { cardAfter, CARD_MAX_MS, closeCard, decideCardAction, type LiveCard } from "./live-card";

const T0 = Date.parse("2026-09-18T22:00:00Z");
const card = (over: Partial<LiveCard> = {}): LiveCard => ({
  messageId: 7,
  at: T0 - 10 * 60_000,
  level: "attention",
  ...over,
});

describe("режим вимкнено", () => {
  it("усе йде окремими повідомленнями, як і було", () => {
    const d = decideCardAction({ enabled: false, card: card(), level: "attention", now: T0 });
    expect(d.action).toBe("send");
  });
});

describe("режим увімкнено", () => {
  it("картки ще немає — перше сповіщення звичайне, зі звуком", () => {
    const d = decideCardAction({ enabled: true, card: null, level: "watch", now: T0 });
    expect(d.action).toBe("send");
    expect(d.reason).toBe("картки ще немає");
  });

  it("той самий рівень — тиха правка замість нового повідомлення", () => {
    const d = decideCardAction({ enabled: true, card: card(), level: "attention", now: T0 });
    expect(d).toEqual({ action: "edit", messageId: 7, reason: "оновлюємо живу картку" });
  });

  it("рівень упав — теж правка: заспокоєння не варте дзвінка", () => {
    const d = decideCardAction({ enabled: true, card: card(), level: "watch", now: T0 });
    expect(d.action).toBe("edit");
  });

  it("ЗАГОСТРЕННЯ завжди окремим повідомленням зі звуком", () => {
    const d = decideCardAction({ enabled: true, card: card(), level: "shelter", now: T0 });
    expect(d.action).toBe("send");
    expect(d.reason).toBe("обстановка загострилась");
  });

  it("картку поховала переписка — відкриваємо нову", () => {
    const d = decideCardAction({
      enabled: true,
      card: card({ at: T0 - CARD_MAX_MS - 1 }),
      level: "attention",
      now: T0,
    });
    expect(d.action).toBe("send");
    expect(d.reason).toBe("картку поховала переписка");
  });
});

describe("стан картки після дії", () => {
  it("нове повідомлення відкриває нову картку з новим часом", () => {
    const prev = card();
    const next = cardAfter(prev, { action: "send", reason: "" }, "shelter", T0, 99);
    expect(next).toEqual({ messageId: 99, at: T0, level: "shelter" });
  });

  it("правка не зсуває час створення картки", () => {
    const prev = card();
    const next = cardAfter(prev, { action: "edit", messageId: 7, reason: "" }, "attention", T0, 7);
    expect(next.at).toBe(prev.at);
  });

  it("рівень картки не знижується правкою", () => {
    const prev = card({ level: "shelter" });
    const next = cardAfter(prev, { action: "edit", messageId: 7, reason: "" }, "watch", T0, 7);
    expect(next.level).toBe("shelter");
  });

  it("і тому повернення до попереднього рівня знову буде ЗАГОСТРЕННЯМ зі звуком", () => {
    // Це і є причина попереднього правила: якби рівень картки знизився до
    // «watch», повернення до «shelter» прийшло б тихою правкою.
    let c: LiveCard | null = card({ level: "shelter" });
    c = cardAfter(c, { action: "edit", messageId: 7, reason: "" }, "watch", T0, 7);
    const back = decideCardAction({ enabled: true, card: c, level: "shelter", now: T0 });
    expect(back.action).toBe("edit"); // рівень не виріс ВІД рівня картки
    // А ось справжнє загострення понад картку — зі звуком:
    const higher = decideCardAction({
      enabled: true,
      card: cardAfter(
        card({ level: "watch" }),
        { action: "edit", messageId: 7, reason: "" },
        "watch",
        T0,
        7,
      ),
      level: "shelter",
      now: T0,
    });
    expect(higher.action).toBe("send");
  });

  it("відбій закриває картку, щоб наступна хвиля відкрила нову", () => {
    expect(closeCard()).toBeNull();
  });
});

describe("замір: скільки дзвінків за двогодинний наліт", () => {
  /*
   * Скарга — на потік. Замір робиться на тій самій послідовності рівнів з
   * ОДНИМ увімкненим і вимкненим режимом, щоб різниця була числом, а не
   * враженням. Послідовність — типова для нальоту: наростання, плато з
   * дрижанням, спад.
   */
  const levels = [
    "watch",
    "watch",
    "attention",
    "attention",
    "watch",
    "attention",
    "attention",
    "shelter",
    "attention",
    "shelter",
    "attention",
    "watch",
    "watch",
    "attention",
    "watch",
    "watch",
  ] as const;

  function run(enabled: boolean): { sends: number; edits: number } {
    let c: LiveCard | null = null;
    let sends = 0;
    let edits = 0;
    levels.forEach((level, i) => {
      const now = T0 + i * 8 * 60_000; // крок паузи між сповіщеннями
      const d = decideCardAction({ enabled, card: c, level, now });
      if (d.action === "send") sends++;
      else edits++;
      c = cardAfter(c, d, level, now, d.action === "edit" ? d.messageId : 100 + i);
    });
    return { sends, edits };
  }

  it("без режиму — дзвінок на кожну зміну; з режимом — лише на загострення", () => {
    const off = run(false);
    const on = run(true);
    expect(off.sends).toBe(levels.length);
    expect(off.edits).toBe(0);
    // Перше сповіщення + два підйоми до «в укриття» + переоткриття картки,
    // коли її ховає переписка (крок 8 хв, стеля 45 хв).
    // Заміряне число, а не «менше»: 16 дзвінків проти 4 за ті самі дві
    // години. Четвірка — це перше сповіщення, два підйоми до «в укриття» і
    // одне переоткриття картки, коли її поховала переписка.
    expect(on.sends).toBe(4);
    expect(on.edits).toBe(12);
  });
});
