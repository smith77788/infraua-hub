import { describe, expect, it } from "bun:test";

import { dangerIndex, personalAssessment } from "./advisory";
import type { Threat, ThreatType } from "./air";
import {
  etaPhrase,
  locationKeyboard,
  parsePersonalAction,
  renderAlert,
  renderAskPoint,
  renderOblastPicked,
  renderPersonal,
  renderSettings,
  settingsKeyboard,
} from "./bot-personal";
import { newSubscriber, type Subscriber } from "./subscribers";

const KYIV = { lat: 50.45, lon: 30.52 };

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

function sub(patch: Partial<Subscriber> = {}): Subscriber {
  return {
    ...newSubscriber(1, "2026-01-01T00:00:00Z"),
    point: { ...KYIV, label: "моя точка" },
    ...patch,
  };
}

function cards(threats: Threat[], radiusKm = 50) {
  const assess = personalAssessment(threats, KYIV, { radiusKm });
  return { assess, danger: dangerIndex(assess) };
}

describe("renderPersonal", () => {
  it("вхідна ціль близько — вердикт «в укриття» і хвилини", () => {
    const { assess, danger } = cards([inbound("a", "shahed", 12)]);
    const text = renderPersonal(assess, danger, "моя точка", 50);
    expect(text).toContain("В УКРИТТЯ");
    expect(text).toContain("іде на вас");
    expect(text).toContain("хв");
  });

  it("порожнє небо — спокій і названий радіус", () => {
    const { assess, danger } = cards([]);
    const text = renderPersonal(assess, danger, "моя точка", 50);
    expect(text).toContain("Спокійно");
    expect(text).toContain("У радіусі 50 км нічого не бачимо");
  });

  it("число завжди йде зі своєю межею — це не радар", () => {
    const { assess, danger } = cards([inbound("a", "shahed", 12)]);
    expect(renderPersonal(assess, danger, "моя точка", 50)).toContain("OSINT");
  });

  it("назва точки екранується — інакше «<» ламає повідомлення", () => {
    const { assess, danger } = cards([]);
    expect(renderPersonal(assess, danger, "дім <b>", 50)).toContain("&lt;b&gt;");
  });
});

describe("renderAlert", () => {
  it("веде головним: що робити, чим і за скільки", () => {
    const { assess, danger } = cards([inbound("a", "ballistic", 30)]);
    const text = renderAlert(assess, danger, "моя точка");
    expect(text.split("\n")[0]).toContain("УКРИТТЯ");
    expect(text).toContain("балістика");
    expect(text).toContain("Повітряні Сили");
  });

  it("кілька вхідних — сказано скільки", () => {
    const { assess, danger } = cards([inbound("a", "shahed", 20), inbound("b", "shahed", 25)]);
    expect(renderAlert(assess, danger, "моя точка")).toContain("Усього на вашу точку: 2");
  });
});

describe("налаштування", () => {
  it("показують усі чотири ручки", () => {
    const text = renderSettings(sub());
    expect(text).toContain("Точка");
    expect(text).toContain("Радіус");
    expect(text).toContain("Будити");
    expect(text).toContain("Уночі");
  });

  it("без точки так і сказано, а не показано порожнє місце", () => {
    expect(renderSettings(sub({ point: null }))).toContain("не задана");
  });

  it("поточний вибір позначений галочкою", () => {
    const kb = settingsKeyboard(sub({ tier: "critical", radiusKm: 100 }));
    const flat = kb.inline_keyboard.flat();
    expect(flat.find((b) => b.callback_data === "t:critical")!.text).toContain("✅");
    expect(flat.find((b) => b.callback_data === "km:100")!.text).toContain("✅");
  });

  it("усі коди кнопок вкладаються в 64 байти Telegram", () => {
    for (const b of settingsKeyboard(sub()).inline_keyboard.flat()) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
  });
});

describe("parsePersonalAction", () => {
  it("розбирає свої кнопки", () => {
    expect(parsePersonalAction("pv")).toEqual({ kind: "refresh" });
    expect(parsePersonalAction("t:all")).toEqual({ kind: "tier", value: "all" });
    expect(parsePersonalAction("n:silent")).toEqual({ kind: "night", value: "silent" });
    expect(parsePersonalAction("km:25")).toEqual({ kind: "radius", value: 25 });
    expect(parsePersonalAction("mu:1")).toEqual({ kind: "mute", value: true });
  });

  it("чужі кнопки віддає далі, а не ковтає", () => {
    // Адмінські коди мають дійти до своєї гілки — інакше панель власника
    // перестане реагувати, щойно зʼявився другий набір кнопок.
    expect(parsePersonalAction("l:on")).toBeNull();
    expect(parsePersonalAction("p:go")).toBeNull();
    expect(parsePersonalAction("t:щось")).toBeNull();
  });
});

describe("прохання точки", () => {
  it("каже, що робиться з координатами", () => {
    expect(renderAskPoint()).toContain("лише для розрахунку відстані");
  });
  it("кнопка геолокації є в приватному чаті й відсутня в групі", () => {
    expect(locationKeyboard("private")).toBeDefined();
    expect(locationKeyboard("supergroup")).toBeUndefined();
  });
});

describe("офіційна тривога в картці", () => {
  it("під чинною тривогою «спокійно» не пишемо — це фальшивий відбій на одного", () => {
    const { assess, danger } = cards([]);
    const text = renderPersonal(assess, danger, "моя точка", 50, { officialAlert: true });
    expect(text).toContain("Триває повітряна тривога");
    expect(text).toContain("Лишайтесь в укритті");
    expect(text).not.toContain("можна спати");
  });

  it("невідомий стан тривоги не видається ні за тривогу, ні за відбій", () => {
    // Збій джерела, зведений до «діє», кричав би щотихого дня; зведений до
    // «знято» — дав би фальшивий відбій. Обидва спрощення шкідливі.
    const { assess, danger } = cards([]);
    const text = renderPersonal(assess, danger, "моя точка", 50, { officialAlert: null });
    expect(text).toContain("невідомий");
    expect(text).not.toContain("Триває повітряна тривога");
    expect(text).not.toContain("можна спати");
  });

  it("відбій офіційно знято — картка спокійна, як і раніше", () => {
    const { assess, danger } = cards([]);
    const text = renderPersonal(assess, danger, "моя точка", 50, { officialAlert: false });
    expect(text).toContain("Спокійно");
  });

  it("тривога не глушить нашу власну — ціль на точці лишається головним", () => {
    const { assess, danger } = cards([inbound("a", "ballistic", 20)]);
    const text = renderPersonal(assess, danger, "моя точка", 50, { officialAlert: true });
    expect(text).toContain("В УКРИТТЯ");
  });
});

describe("прохання точки веде трьома шляхами, а не одним", () => {
  it("перший спосіб — той, що працює скрізь і без дозволів", () => {
    // Скарга «натиснув кнопку поділитись локацією — нічого не сталося»:
    // раніше текст вів до ОДНІЄЇ кнопки, яка на компʼютері не робить нічого.
    const text = renderAskPoint();
    expect(text).toContain("Оберіть область кнопками");
    expect(text).toContain("не питає жодних дозволів");
  });

  it("названо, що саме робити на компʼютері", () => {
    expect(renderAskPoint()).toContain("Локація");
    expect(renderAskPoint()).toContain("компʼютер");
  });

  it("вибір області не мовчить про свою грубість", () => {
    const text = renderOblastPicked("Харківщина");
    expect(text).toContain("центр області");
    expect(text).toContain("десятки кілометрів");
  });
});

describe("ETA не вдає точності, якої немає", () => {
  it("до години — число, бо воно ще щось означає", () => {
    expect(etaPhrase(12)).toBe(", ~12 хв до вас");
  });

  it("за годиною число не показуємо взагалі", () => {
    // «~240 хв до вас» виглядає точніше, ніж будь-що, що ми знаємо: ціль до
    // того часу кілька разів змінить курс, або її зіб'ють.
    expect(etaPhrase(240)).toBe(", далеко — понад годину");
    expect(etaPhrase(240)).not.toContain("240");
  });

  it("курсу немає — мовчимо, а не пишемо нуль", () => {
    expect(etaPhrase(null)).toBe("");
  });
});

describe("картка не повторює застереження двічі", () => {
  it("рядок про OSINT один", () => {
    const { assess, danger } = cards([inbound("a", "shahed", 12)]);
    const text = renderPersonal(assess, danger, "моя точка", 50);
    expect(text.split("OSINT")).toHaveLength(2);
  });

  it("порожній радіус не читається як порожня країна", () => {
    const assess = personalAssessment([inbound("a", "shahed", 300)], KYIV, { radiusKm: 50 });
    const text = renderPersonal(assess, dangerIndex(assess), "моя точка", 50);
    expect(text).toContain("У радіусі 50 км нічого не бачимо");
    expect(text).toContain("поза вашим радіусом");
  });
});

/*
 * Людину підняли о третій ночі. Вона мусить бачити не лише «за скільки», а й
 * наскільки цьому взагалі можна вірити: «підтверджена, ±4 км» і «не
 * підтверджена, ±45 км, курс припущений» — це два різні рішення, і досі вони
 * виглядали в повідомленні однаково.
 */
describe("renderAlert — якість даних видно людині", () => {
  const withQuality = (kmSouth: number, quality: NonNullable<Threat["quality"]>): Threat => ({
    ...inbound("q", "shahed", kmSouth),
    quality,
  });

  it("широка невизначеність подається вилкою, а не одним числом", () => {
    const t = withQuality(120, {
      uncertaintyKm: 45,
      position: "approx",
      lifecycle: "uncertain",
      presumptiveCourse: true,
      speedKmh: null,
    });
    const assess = personalAssessment([t], KYIV);
    const text = renderAlert(assess, dangerIndex(assess), "моя точка");
    expect(text).toMatch(/\d+–\d+ хв/);
    expect(text).toContain("не підтверджена");
    expect(text).toContain("±45 км");
    expect(text).toContain("курс припущений");
  });

  it("підтверджена ціль не обвішується застереженнями", () => {
    const t = withQuality(40, {
      uncertaintyKm: 4,
      position: "confirmed",
      lifecycle: "confirmed",
      presumptiveCourse: false,
      speedKmh: null,
    });
    const assess = personalAssessment([t], KYIV);
    const text = renderAlert(assess, dangerIndex(assess), "моя точка");
    expect(text).toContain("підтверджена");
    expect(text).not.toContain("припущений");
  });

  it("заміряна швидкість називається заміряною", () => {
    const t = withQuality(60, {
      uncertaintyKm: 4,
      position: "confirmed",
      lifecycle: "tracking",
      presumptiveCourse: false,
      speedKmh: 99.4,
    });
    const assess = personalAssessment([t], KYIV);
    expect(renderAlert(assess, dangerIndex(assess), "моя точка")).toContain("швидкість заміряна");
  });

  it("мовчання джерела не друкується як «дані відсутні»", () => {
    const assess = personalAssessment([inbound("a", "shahed", 40)], KYIV);
    const text = renderAlert(assess, dangerIndex(assess), "моя точка");
    expect(text).not.toContain("±");
    expect(text).not.toContain("не підтверджена");
  });
});
