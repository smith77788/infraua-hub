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
  renderShelters,
  settingsKeyboard,
} from "./bot-personal";
import { newSubscriber, type Subscriber, NIGHT_WAKE_MIN } from "./subscribers";
import type { NearbyShelter } from "./shelters";

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

describe("renderShelters", () => {
  const s = (over: Partial<NearbyShelter> = {}): NearbyShelter => ({
    id: "n/1",
    kind: "metro",
    name: "Арсенальна",
    lat: 50.444,
    lon: 30.545,
    distanceKm: 0.3,
    walkMin: 4,
    ...over,
  });

  it("веде на карту, а не диктує координати", () => {
    const t = renderShelters([s()], "застереження");
    expect(t).toContain("openstreetmap.org");
    expect(t).toContain("4 хв пішки");
  });

  it("паркінг не видається за обладнане укриття", () => {
    const t = renderShelters([s({ kind: "underground", name: "Паркінг" })], "з");
    expect(t).toContain("не обладнане укриття");
  });

  it("порожній список дає пораду, а не мовчання", () => {
    const t = renderShelters([], "це не державний реєстр");
    expect(t).toContain("без вікон");
    expect(t).toContain("це не державний реєстр");
  });

  it("застереження про покриття є завжди", () => {
    expect(renderShelters([s()], "МЕЖА")).toContain("МЕЖА");
  });

  it("примітка про безпечний бік показується під потрібним укриттям", () => {
    const t = renderShelters([s({ id: "a" }), s({ id: "b" })], "з", false, {
      b: "у протилежний від загрози бік",
    });
    expect(t).toContain("↳ у протилежний від загрози бік");
    // Без примітки для «a» — зайвого рядка нема.
    expect(t.match(/↳/g)?.length).toBe(1);
  });
});

describe("«на вас» більше не означає «в секторі»", () => {
  function withMotion(missKm: number, etaMin: number | null, inbound: boolean) {
    const { assess } = cards([inbound ? inbound0() : outbound0()]);
    const n = assess.nearest[0]!;
    return renderPersonal(
      {
        ...assess,
        nearest: [{ ...n, inbound, missKm, etaMin, etaRangeMin: null }],
      },
      dangerIndex(assess),
      "моя точка",
      50,
    );
  }
  function inbound0() {
    return inbound("a", "shahed", 20);
  }
  function outbound0() {
    return { ...inbound("a", "shahed", 20), heading: 180 };
  }

  it("ціль, що промине збоку, так і підписана — а не «іде на вас»", () => {
    const text = withMotion(22, 14, false);
    expect(text).toContain("промине за ~22 км");
    expect(text).not.toContain("іде на вас");
  });

  it("близький проліт не захаращує рядок зайвим числом", () => {
    expect(withMotion(1, 14, false)).not.toContain("промине");
  });

  it("ціль, що віддаляється, не отримує «промине»", () => {
    expect(withMotion(22, null, false)).not.toContain("промине");
  });

  it("вхідна ціль лишається вхідною", () => {
    expect(withMotion(0, 14, true)).toContain("іде на вас");
  });
});

describe("сповіщення каже, наскільки стара сама позиція", () => {
  const NOW = Date.parse("2026-09-16T21:07:58Z");
  const KYIV = { lat: 50.45, lon: 30.52 };

  function inbound(agoSec: number): Threat {
    return {
      id: "a",
      name: "Ціль",
      lat: KYIV.lat - 0.25,
      lon: KYIV.lon,
      source: "neptun.in.ua",
      count: 1,
      since: "",
      expires: "",
      lastSeen: new Date(NOW - agoSec * 1000).toISOString(),
      type: "shahed",
      heading: 0,
      quality: {
        uncertaintyKm: 4,
        position: "confirmed",
        lifecycle: "confirmed",
        presumptiveCourse: false,
        speedKmh: null,
      },
    };
  }

  const render = (agoSec: number): string => {
    const assess = personalAssessment([inbound(agoSec)], KYIV, { radiusKm: 100, now: NOW });
    return renderAlert(assess, dangerIndex(assess), "моя точка", { now: NOW });
  };

  it("застаріла позиція названа вголос", () => {
    /*
     * Час підльоту вже враховує застій, а ВІДСТАНЬ — ні: у тексті стоїть число
     * джерела. Людина читає «27 км» як «зараз двадцять сім», хоча заміряна
     * медіана застою — 205 секунд, тобто ще 10 км польоту шахеда.
     */
    expect(render(205)).toContain("позиція 3 хв тому");
  });

  it("свіжу позицію не згадуємо — це був би шум у кожному сповіщенні", () => {
    const text = render(20);
    expect(text).not.toContain("позиція");
  });

  it("межа названа явно: півтори хвилини", () => {
    expect(render(80)).not.toContain("позиція");
    expect(render(100)).toContain("позиція");
  });

  it("без часу від джерела вік не вигадується", () => {
    const t = { ...inbound(205), lastSeen: "", since: "" };
    const assess = personalAssessment([t], KYIV, { radiusKm: 100, now: NOW });
    expect(renderAlert(assess, dangerIndex(assess), "моя точка", { now: NOW })).not.toContain(
      "позиція",
    );
  });
});

describe("підпис нічного режиму каже, що він робить", () => {
  it("не обіцяє «лише критичне», бо це вже неправда", () => {
    /*
     * Поведінку `night: "critical"` змінено: фільтр типів більше не діє, коли
     * ціль ось-ось прилетить (причина — з усталеним режимом наліт шахедів
     * уночі давав нуль сповіщень). Лишити старий підпис означало б зробити те
     * саме, що виправлялось у публічному API й у тексті каналу: код, який не
     * робить того, що про нього написано.
     */
    const text = renderSettings(sub({ night: "critical" }));
    expect(text).not.toContain("лише критичне");
  });

  it("називає число, за яким дрон уночі розбудить", () => {
    const text = renderSettings(sub({ night: "critical" }));
    expect(text).toContain(String(NIGHT_WAKE_MIN));
    expect(text).toContain("до підльоту");
  });

  it("каже, що ракети будять на будь-якій відстані", () => {
    expect(renderSettings(sub({ night: "critical" }))).toContain("Ракети");
  });

  it("«тиша» лишається тишею й у підписі", () => {
    expect(renderSettings(sub({ night: "silent" }))).toContain("тиша");
  });
});
