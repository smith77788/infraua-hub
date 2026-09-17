import { describe, expect, it } from "bun:test";

import { dangerIndex, personalAssessment } from "./advisory";
import type { Threat, ThreatType } from "./air";
import { withinLead } from "./lead-threshold";
import {
  ALERT_COOLDOWN_MS,
  ALERT_FLOOR_MS,
  ALERT_FORGET_MS,
  clampRadius,
  decideAlert,
  forgetStale,
  isNight,
  markAlerted,
  newSubscriber,
  parseNight,
  parseTier,
  refCode,
  type Subscriber,
} from "./subscribers";

const KYIV = { lat: 50.45, lon: 30.52 };

/** Ціль на південь від точки, курсом рівно на північ — тобто просто на неї. */
function inbound(id: string, type: ThreatType, kmSouth: number): Threat {
  return {
    id,
    name: "Ціль",
    lat: KYIV.lat - kmSouth / 111,
    lon: KYIV.lon,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    type,
    heading: 0,
  };
}

/** Ціль поруч, але курсом ГЕТЬ від точки. */
function outbound(id: string, kmSouth: number): Threat {
  return { ...inbound(id, "shahed", kmSouth), heading: 180 };
}

function sub(patch: Partial<Subscriber> = {}): Subscriber {
  return {
    ...newSubscriber(777, "2026-01-01T00:00:00Z"),
    point: { ...KYIV, label: "моя точка" },
    ...patch,
  };
}

function decide(s: Subscriber, threats: Threat[], now = 1_000_000, hour = 12) {
  const assess = personalAssessment(threats, s.point!, { radiusKm: s.radiusKm });
  return decideAlert(s, assess, dangerIndex(assess), now, hour);
}

describe("refCode", () => {
  it("стабільний для того самого chatId", () => {
    expect(refCode(12345)).toBe(refCode(12345));
  });
  it("різні chatId — різні коди", () => {
    expect(refCode(12345)).not.toBe(refCode(12346));
  });
  it("не містить самого chatId — інакше посилання видавало б Telegram-id", () => {
    expect(refCode(12345)).not.toContain("12345");
  });
});

describe("isNight", () => {
  it("23:00 і 03:00 — ніч, 08:00 і 22:00 — ні", () => {
    expect(isNight(23)).toBe(true);
    expect(isNight(3)).toBe(true);
    expect(isNight(8)).toBe(false);
    expect(isNight(22)).toBe(false);
  });
});

describe("decideAlert", () => {
  it("нічого не йде на точку — мовчимо", () => {
    const d = decide(sub(), [outbound("a", 30)]);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("нічого не йде");
  });

  it("вхідна ціль у радіусі — будимо", () => {
    const d = decide(sub(), [inbound("a", "shahed", 40)]);
    expect(d.send).toBe(true);
    expect(d.ids).toEqual(["a"]);
  });

  it("вхідна ціль ДАЛІ за радіус — мовчимо", () => {
    const d = decide(sub({ radiusKm: 25 }), [inbound("a", "shahed", 90)]);
    expect(d.send).toBe(false);
  });

  it("поріг «лише критичне» пропускає ракету і не пропускає шахед", () => {
    expect(decide(sub({ tier: "critical" }), [inbound("a", "shahed", 40)]).send).toBe(false);
    expect(decide(sub({ tier: "critical" }), [inbound("b", "ballistic", 40)]).send).toBe(true);
  });

  it("нічна тиша не будить навіть балістикою", () => {
    const d = decide(sub({ night: "silent" }), [inbound("a", "ballistic", 40)], 1_000_000, 2);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("тиша");
  });

  it("нічний режим «критичне» глушить ДАЛЕКИЙ шахед, але не ракету", () => {
    /*
     * Тест був написаний під правило «вночі лише критичні типи» й перевіряв
     * шахеда за 40 км. Правило змінено: вночі фільтр типів не діє, коли ціль
     * ось-ось прилетить (ймовірний підліт ≤ 15 хв). Сорок кілометрів — це 13
     * хвилин, тобто саме той випадок, заради якого виняток і зроблено.
     *
     * Те, що тест перевіряв по суті — «дрон уночі не будить так само, як
     * ракета», — лишається правдою на відстані, де запас часу справді є.
     */
    expect(decide(sub({ radiusKm: 100 }), [inbound("a", "shahed", 80)], 1_000_000, 2).send).toBe(
      false,
    );
    expect(decide(sub({ radiusKm: 100 }), [inbound("b", "cruise", 80)], 1_000_000, 2).send).toBe(
      true,
    );
  });

  it("поріг часу: далеку ціль тримаємо мовчки, поки є запас часу", () => {
    // Радіус великий, але поріг «≤5 хв льоту»: шахед за 90 км (низ вилки ~8 хв)
    // ще не терміновий. lastLevel = shelter, щоб перше сповіщення не рахувалось
    // ескалацією (вона поріг пробиває — і це правильно).
    const d = decide(sub({ radiusKm: 120, leadMin: 5, lastLevel: "shelter" }), [
      inbound("a", "shahed", 90),
    ]);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("ще є час");
  });

  it("поріг часу: близька ціль у вікні — будимо", () => {
    const d = decide(sub({ radiusKm: 120, leadMin: 5, lastLevel: "shelter" }), [
      inbound("a", "shahed", 20),
    ]);
    expect(d.send).toBe(true);
  });

  it("ескалація поріг часу НЕ пробиває — інакше поріг був би несправжнім", () => {
    // Спокуслива й неправильна версія цього правила — «ескалація важливіша за
    // поріг». Вона робить поріг майже неіснуючим, і ось чому: `forgetStale`
    // скидає `lastLevel` у null після 45 хв тиші, тобто на початку КОЖНОГО
    // нальоту. Свіжий `lastLevel: null` дає `escalated === true`, і перше
    // сповіщення обходило б поріг щоразу — саме те далеке нічне, від якого
    // людина й ставила «будити за 5 хв».
    const fresh = sub({ radiusKm: 120, leadMin: 5 });
    expect(fresh.lastLevel).toBe(null);
    const d = decide(fresh, [inbound("a", "shahed", 90)]);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("ще є час");
  });

  it("заглушене порогом не запамʼятовується — щойно ціль у вікні, сповіщення йде", () => {
    // Друга половина того самого рішення: затримки поріг не додає. Мовчання не
    // викликає markAlerted, тож lastLevel лишається null — і в ту ж мить, коли
    // ціль входить у вікно, спрацьовує звичайна ескалація.
    const s = sub({ radiusKm: 120, leadMin: 5 });
    expect(decide(s, [inbound("a", "shahed", 90)]).send).toBe(false);
    const near = decide(s, [inbound("a", "shahed", 30)]);
    expect(near.send).toBe(true);
    expect(near.reason).toContain("загострилась");
  });

  it("поріг переживає forgetStale — він не стан, а налаштування", () => {
    const s = forgetStale(
      { ...sub({ radiusKm: 120, leadMin: 5 }), lastAlertAt: 1, lastLevel: "shelter" },
      1 + ALERT_FORGET_MS + 1,
    );
    expect(s.lastLevel).toBe(null);
    expect(s.leadMin).toBe(5);
    expect(decide(s, [inbound("a", "shahed", 90)]).send).toBe(false);
  });

  it("поріг часу вимкнено — радіус вирішує, як раніше", () => {
    const d = decide(sub({ radiusKm: 120, leadMin: null, lastLevel: "shelter" }), [
      inbound("a", "shahed", 90),
    ]);
    expect(d.send).toBe(true);
  });

  it("нічний режим не РОЗШИРЮЄ денний: «лише критичне» вдень лишається таким і вночі", () => {
    const s = sub({ tier: "critical", night: "all" });
    expect(decide(s, [inbound("a", "shahed", 40)], 1_000_000, 2).send).toBe(false);
  });

  it("про ту саму ціль удруге не пишемо, поки триває пауза", () => {
    const threats = [inbound("a", "shahed", 40)];
    const first = decide(sub(), threats);
    const after = markAlerted(sub(), first, 1_000_000);
    // Одразу після надсилання спрацьовує жорстка підлога…
    expect(decide(after, threats, 1_000_000 + 60_000).reason).toContain("щойно надсилали");
    // …а далі, вже за підлогою, мовчить саме дедуп за цілями.
    const second = decide(after, threats, 1_000_000 + 5 * 60_000);
    expect(second.send).toBe(false);
    expect(second.reason).toContain("щойно повідомили");
  });

  it("нова ціль пробиває паузу — але не раніше за жорстку підлогу", () => {
    const after = markAlerted(sub(), decide(sub(), [inbound("a", "shahed", 40)]), 1_000_000);
    const threats = [inbound("a", "shahed", 40), inbound("b", "shahed", 45)];
    // Через хвилину — ще зарано: якщо джерело перестворило трек з новим id,
    // це було б друге сповіщення про ту саму ціль.
    expect(decide(after, threats, 1_000_000 + 60_000).send).toBe(false);
    expect(decide(after, threats, 1_000_000 + ALERT_FLOOR_MS + 1_000).send).toBe(true);
  });

  it("ескалація типу пробиває паузу навіть без нових ідентифікаторів", () => {
    // Та сама ціль «a», але тепер вона визначена як балістика й підійшла ближче:
    // рівень небезпеки виріс, і мовчати тут — гірше за зайве повідомлення.
    const first = decide(sub(), [inbound("a", "shahed", 120)]);
    const after = markAlerted(sub(), first, 1_000_000);
    const second = decide(after, [inbound("a", "ballistic", 20)], 1_000_000 + 10_000);
    expect(second.send).toBe(true);
    expect(second.reason).toContain("загострилась");
  });

  it("пауза на паузі — жодних сповіщень", () => {
    expect(decide(sub({ muted: true }), [inbound("a", "ballistic", 10)]).send).toBe(false);
  });

  it("без точки рішення не ухвалюється", () => {
    expect(decide(sub({ point: null }), []).send).toBe(false);
  });
});

describe("forgetStale", () => {
  it("після довгої тиші історія стирається — друга хвиля знову нова", () => {
    const s = sub({ lastAlertAt: 1_000, lastAlertIds: ["a"], lastLevel: "attention" });
    expect(forgetStale(s, 1_000 + ALERT_COOLDOWN_MS).lastAlertIds).toEqual(["a"]);
    expect(forgetStale(s, 1_000 + 60 * 60 * 1000).lastAlertIds).toEqual([]);
  });
});

describe("розбір налаштувань", () => {
  it("невідоме значення не перетворюється на усталене", () => {
    expect(parseTier("critical")).toBe("critical");
    expect(parseTier("щось")).toBeNull();
    expect(parseNight("silent")).toBe("silent");
    expect(parseNight("")).toBeNull();
  });
  it("радіус затискається в межі, а не відхиляється", () => {
    expect(clampRadius(1)).toBe(10);
    expect(clampRadius(9999)).toBe(200);
    expect(clampRadius(Number.NaN)).toBe(50);
  });
});

describe("поріг запасу часу (leadMin)", () => {
  it("мовчить, поки до підльоту більше, ніж просили", () => {
    // Шахед за 90 км: найбезпечніше прочитання часу — 8 хв. Людина просила
    // будити за 5. Це не проґавлена ціль, а рівно те, про що домовлялись.
    const d = decide(sub({ leadMin: 5, radiusKm: 100 }), [inbound("a", "shahed", 90)]);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("поріг");
  });

  it("будить, коли та сама ціль підійшла в межі порога", () => {
    const d = decide(sub({ leadMin: 5, radiusKm: 100 }), [inbound("a", "shahed", 45)]);
    expect(d.send).toBe(true);
  });

  it("швидку ціль пропускає там, де повільну затримав би", () => {
    const far = 90;
    const slow = decide(sub({ leadMin: 5, radiusKm: 100 }), [inbound("a", "shahed", far)]);
    const fast = decide(sub({ leadMin: 5, radiusKm: 100 }), [inbound("b", "ballistic", far)]);
    expect(slow.send).toBe(false);
    expect(fast.send).toBe(true);
  });

  it("без порога поводиться точно як раніше", () => {
    const withOff = decide(sub({ radiusKm: 100 }), [inbound("a", "shahed", 90)]);
    const withNull = decide(sub({ leadMin: null, radiusKm: 100 }), [inbound("a", "shahed", 90)]);
    expect(withOff.send).toBe(true);
    expect(withNull.send).toBe(true);
  });

  it("ціль без курсу відсікає не поріг, а відсутність напрямку на точку", () => {
    // Важлива межа: сьогодні «вхідна» і «має оцінений час підльоту» — це те
    // саме. Ціль без курсу не потрапляє в pool взагалі, тож про поріг тут не
    // йдеться, і причина має називати саме це, а не запас часу.
    const { heading: _drop, ...noHeading } = inbound("a", "shahed", 90);
    const d = decide(sub({ leadMin: 5, radiusKm: 100 }), [noHeading]);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("нічого не йде");
    expect(d.reason).not.toContain("поріг");
  });

  it("невідомий час підльоту поріг пропускає, а не відсікає", () => {
    // Оборонна гілка: `personalAssessment` сьогодні завжди дає час для вхідної
    // цілі, тож із `decideAlert` цей випадок не досяжний. Але правило перевірене
    // тут навмисно — щоб зміна оцінювача не перетворила «не знаю» на «мовчи».
    expect(withinLead(null, 5).within).toBe(true);
    expect(withinLead(null, 5).reason).toContain("невідом");
  });

  it("поріг рахується по тих цілях, які будили б, а не по всіх у радіусі", () => {
    // tier «лише критичне» лишає балістику; шахед поруч не має підміняти собою
    // запас часу тієї цілі, про яку людину справді повідомлять.
    const s = sub({ leadMin: 5, radiusKm: 100, tier: "critical" });
    const d = decide(s, [inbound("slow", "shahed", 95), inbound("fast", "ballistic", 90)]);
    expect(d.send).toBe(true);
    expect(d.ids).toEqual(["fast"]);
  });
});

describe("нічний режим не має мовчати, коли ціль уже поруч", () => {
  /**
   * Заміряно на симуляції двогодинного нальоту шести шахедів на точку людини:
   * з УСТАЛЕНИМИ налаштуваннями вночі виходило нуль сповіщень, удень — сім.
   * Усталене `night: "critical"`, а шахед не входить у критичні типи — тобто
   * типова конфігурація мовчала рівно в тій події, заради якої продукт існує.
   */
  const NIGHT = 3;
  const DAY = 12;

  it("шахед за 10 км уночі будить, хоч він і не «критичний тип»", () => {
    const d = decide(sub({ night: "critical" }), [inbound("a", "shahed", 10)], 1_000_000, NIGHT);
    expect(d.send).toBe(true);
  });

  it("далекий шахед уночі так само мовчить — фільтр не скасовано", () => {
    // Ймовірний підліт на 80 км — близько 26 хв, тобто запас часу є, і нічний
    // фільтр типів працює як раніше. Радіус задаємо явно: усталені 50 км самі
    // відсікли б ціль, і тест перевіряв би не те, що треба.
    const d = decide(
      sub({ night: "critical", radiusKm: 100 }),
      [inbound("a", "shahed", 80)],
      1_000_000,
      NIGHT,
    );
    expect(d.send).toBe(false);
  });

  it("«тиша» лишається тишею — її не пробиває ніщо", () => {
    const d = decide(sub({ night: "silent" }), [inbound("a", "shahed", 5)], 1_000_000, NIGHT);
    expect(d.send).toBe(false);
    expect(d.reason).toContain("тиша");
  });

  it("хто просив лише ракети — лише ракети й отримує, і вночі теж", () => {
    /*
     * Головна межа: вночі пробиває не ТИП, а близькість. Обіцянка «нічний
     * режим лише звужує денний» лишається цілою, бо `tier` звужує в обох
     * режимах і тут не чіпається.
     */
    const s = sub({ tier: "critical", night: "critical" });
    expect(decide(s, [inbound("a", "shahed", 5)], 1_000_000, NIGHT).send).toBe(false);
    expect(decide(s, [inbound("a", "shahed", 5)], 1_000_000, DAY).send).toBe(false);
  });

  it("критичний тип уночі будить, як і раніше", () => {
    const d = decide(
      sub({ night: "critical", radiusKm: 100 }),
      [inbound("a", "ballistic", 80)],
      1_000_000,
      NIGHT,
    );
    expect(d.send).toBe(true);
  });

  it("удень поведінка не змінилась: далекий шахед будить, бо фільтра типів немає", () => {
    const s = sub({ night: "critical", radiusKm: 100 });
    expect(decide(s, [inbound("a", "shahed", 80)], 1_000_000, DAY).send).toBe(true);
  });
});
