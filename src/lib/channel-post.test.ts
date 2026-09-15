import { describe, expect, it } from "bun:test";

import type { Threat } from "./air";
import { channelKeyboard, hashtags, oblastOf, renderChannelPost } from "./channel-post";

function threat(p: Partial<Threat>): Threat {
  return {
    id: Math.random().toString(36).slice(2),
    name: "Ціль",
    lat: 50,
    lon: 30,
    source: "neptun.in.ua",
    count: 1,
    since: "",
    expires: "",
    ...p,
  };
}

describe("oblastOf", () => {
  it("координата Києва → м. Київ", () => {
    expect(oblastOf(50.45, 30.52)).toBe("м. Київ");
  });
  it("координата Миколаєва → Миколаївщина", () => {
    expect(oblastOf(46.97, 32.0)).toBe("Миколаївщина");
  });
});

describe("renderChannelPost", () => {
  it("порожньо в небі — постити нічого", () => {
    expect(renderChannelPost([])).toBeNull();
  });

  it("рахує однотипні цілі однією фразою «ванёк»-регістру", () => {
    const post = renderChannelPost([
      threat({ lat: 51.0, lon: 34.5, type: "shahed" }),
      threat({ lat: 51.1, lon: 34.6, type: "shahed" }),
      threat({ lat: 51.2, lon: 34.7, type: "shahed" }),
    ])!;
    expect(post.text).toContain("3 шахеди");
    expect(post.targets).toBe(3);
  });

  it("додає курс, коли він відомий", () => {
    const post = renderChannelPost([threat({ lat: 49.0, lon: 33.0, type: "shahed", heading: 0 })])!;
    expect(post.text).toContain("курсом на північ");
  });

  it("«у бік міста», коли ціль іде на місто поруч", () => {
    // ціль трохи південніше Полтави (49.59,34.55), курс 0° = на неї
    const post = renderChannelPost([
      threat({ lat: 49.3, lon: 34.55, type: "shahed", heading: 0 }),
    ])!;
    expect(post.text).toContain("у бік: Полтавщина");
    /*
     * Час до міста подається вилкою, коли вона широка, і одним числом, коли
     * вузька. Для шахеда вона широка завжди: «шахед» покриває і 185 км/год,
     * і 600, а позиція відома з точністю, яку називає джерело. Одне число тут
     * ішло б у канал на всю країну як вимір.
     */
    expect(post.text).toMatch(/у бік: Полтавщина \((~\d+ хв|\d+–\d+ хв|може бути вже поруч)\)/);
  });

  it("шапка веде найгострішим: ракета важливіша за мопед", () => {
    const post = renderChannelPost([
      threat({ lat: 51, lon: 34.5, type: "shahed" }),
      threat({ lat: 50, lon: 30, type: "missile" }),
    ])!;
    expect(post.text.startsWith("🚀")).toBe(true);
    expect(post.text.toLowerCase()).toContain("ракет");
  });

  it("без ракет шапка про шахеди", () => {
    const post = renderChannelPost([threat({ lat: 51, lon: 34.5, type: "shahed" })])!;
    expect(post.text.startsWith("🛸")).toBe(true);
  });

  it("значок типу і загальний лік у пості", () => {
    const post = renderChannelPost([
      threat({ lat: 51, lon: 34.5, type: "shahed" }),
      threat({ lat: 51.1, lon: 34.6, type: "shahed" }),
    ])!;
    expect(post.text).toContain("🛸");
    expect(post.text).toContain("всього в небі: 2");
  });

  it("count (згадки в OSINT) НЕ роздуває кількість цілей", () => {
    // Одна ціль із 17 згадок — це ОДИН об'єкт, а не «17 мопедов». Саме так
    // канал розходився з картою й писав фейкові числа.
    const post = renderChannelPost([threat({ lat: 46.6, lon: 32.6, type: "shahed", count: 17 })])!;
    expect(post.text).toContain("1 шахед");
    expect(post.text).not.toContain("17");
    expect(post.targets).toBe(1);
  });

  it("масований наліт: тіло обмежене, підпис бачить усе", () => {
    const post = renderChannelPost(
      [
        threat({ lat: 51, lon: 34.5, type: "shahed" }),
        threat({ lat: 46.97, lon: 32.0, type: "shahed" }),
      ],
      { maxOblasts: 1 },
    )!;
    // Показано лише одну область у тілі, решта згорнута.
    expect(post.text).toContain("…і ще 1 область");
    // Але дедуп-підпис усе одно містить обидві.
    expect(post.signature.split("|").length).toBe(2);
  });

  it("живе оновлення: веде зміну, а не повтор тієї самої картини", () => {
    const first = renderChannelPost([threat({ lat: 46.6, lon: 32.6, type: "shahed" })])!;
    // Та сама картина вдруге — несуттєво, постити не варто.
    const same = renderChannelPost([threat({ lat: 46.6, lon: 32.6, type: "shahed" })], {
      previous: first.snapshot,
    })!;
    expect(same.material).toBe(false);

    // З'явилась нова область — суттєво, і в тексті видно, що саме змінилось.
    const grown = renderChannelPost(
      [
        threat({ lat: 46.6, lon: 32.6, type: "shahed" }),
        threat({ lat: 49.9, lon: 36.2, type: "shahed" }),
      ],
      { previous: first.snapshot },
    )!;
    expect(grown.material).toBe(true);
    // Словами, а не бейджем: «🆕» Telegram малює значком NEW, який нічого не
    // каже українською, і люди його просто не розуміли.
    expect(grown.text).toContain("Зʼявились цілі:");
  });

  it("ескалація до ракет — завжди суттєво", () => {
    const drones = renderChannelPost([threat({ lat: 46.6, lon: 32.6, type: "shahed" })])!;
    const rockets = renderChannelPost(
      [
        threat({ lat: 46.6, lon: 32.6, type: "shahed" }),
        threat({ lat: 47.8, lon: 35.1, type: "missile" }),
      ],
      { previous: drones.snapshot },
    )!;
    expect(rockets.material).toBe(true);
    expect(rockets.text).toContain("⚠️");
  });

  it("однакова картина дає однаковий підпис (дедуп)", () => {
    const a = renderChannelPost([threat({ lat: 51, lon: 34.5, type: "shahed" })])!;
    const b = renderChannelPost([threat({ lat: 51, lon: 34.5, type: "shahed" })])!;
    expect(a.signature).toBe(b.signature);
  });

  it("інша картина — інший підпис", () => {
    const a = renderChannelPost([threat({ lat: 51, lon: 34.5, type: "shahed" })])!;
    const b = renderChannelPost([
      threat({ lat: 51, lon: 34.5, type: "shahed" }),
      threat({ lat: 51, lon: 34.5, type: "missile" }),
    ])!;
    expect(a.signature).not.toBe(b.signature);
  });
});

describe("хештеги", () => {
  it("складаються лише з літер — Telegram обриває тег на першому не-літері", () => {
    // «м. Київ» як «#м. Київ» дало б марний тег «#м».
    const tags = hashtags(["м. Київ"], new Set(["shahed"]));
    expect(tags).toContain("#мКиїв");
    expect(tags).not.toContain("#м ");
  });

  it("область іде перед типом: шукають «що в моїй області»", () => {
    const tags = hashtags(["Сумщина"], new Set(["shahed"]));
    expect(tags.indexOf("#Сумщина")).toBeLessThan(tags.indexOf("#шахеди"));
  });

  it("шахед і реактивний шахед не дають двох однакових тегів", () => {
    const tags = hashtags(["Сумщина"], new Set(["shahed", "reactive"]));
    expect(tags.split(" ").filter((t) => t === "#шахеди")).toHaveLength(1);
  });

  it("постійний тег є завжди — за ним канал знаходять ті, хто про нього не чув", () => {
    expect(hashtags([], new Set())).toContain("#повітрянатривога");
  });
});

describe("пост із прогнозом", () => {
  it("рядок прогнозу потрапляє в текст і не ламає підпис дедупу", () => {
    const threats = [threat({ lat: 50.91, lon: 34.8, type: "shahed", heading: 180 })];
    const withF = renderChannelPost(threats, { forecast: "🔮 <b>За курсом далі:</b> Полтавщина" })!;
    const without = renderChannelPost(threats)!;
    expect(withF.text).toContain("За курсом далі");
    expect(withF.signature).toBe(without.signature);
  });

  it("хештеги вкладені в сам текст поста", () => {
    const post = renderChannelPost([threat({ lat: 50.91, lon: 34.8, type: "shahed" })])!;
    expect(post.text).toContain(post.hashtags);
    expect(post.hashtags).toContain("#Сумщина");
  });
});

describe("channelKeyboard", () => {
  it("кнопка бота їде разом із пересланим постом", () => {
    const kb = channelKeyboard("https://t.me/b?start=ch", "https://radar.example")!;
    expect(kb.inline_keyboard[0]).toHaveLength(2);
    expect(kb.inline_keyboard[0]![0]!.url).toBe("https://t.me/b?start=ch");
  });
  it("немає що показати — немає й клавіатури, а не порожній ряд", () => {
    expect(channelKeyboard(null, null)).toBeUndefined();
  });
});

describe("англійська версія поста", () => {
  const threats = [
    threat({ lat: 50.91, lon: 34.8, type: "shahed", heading: 180, reports: 4 }),
    threat({ lat: 50.9, lon: 34.7, type: "shahed", heading: 180, reports: 4 }),
  ];

  it("складається з тих самих чисел, а не перекладається з українського", () => {
    const uk = renderChannelPost(threats)!;
    const en = renderChannelPost(threats, { lang: "en" })!;
    // Головна гарантія: англійський канал не може сказати іншу кількість.
    expect(en.targets).toBe(uk.targets);
    expect(en.signature).toBe(uk.signature);
    expect(en.text).toContain("2 Shahed drones");
    expect(en.text).toContain("2 in the air");
  });

  it("не лишає українських хвостів у тексті", () => {
    const en = renderChannelPost(threats, { lang: "en" })!;
    expect(en.text).not.toContain("шахед");
    expect(en.text).not.toContain("курсом");
    expect(en.text).not.toContain("OSINT · бережіть");
  });

  it("назви областей лишаються як є — це власні назви, а не переклад", () => {
    const en = renderChannelPost(threats, { lang: "en" })!;
    expect(en.text).toContain("Сумщина");
  });

  it("хештеги теж англійські — за ними шукає інша аудиторія", () => {
    const en = renderChannelPost(threats, { lang: "en" })!;
    expect(en.hashtags).toContain("#Shahed");
    expect(en.hashtags).toContain("#Ukraine");
  });
});

describe("рівень довіри в пості", () => {
  it("область на одному непідтвердженому повідомленні позначена", () => {
    const post = renderChannelPost([
      threat({ lat: 50.91, lon: 34.8, type: "shahed", reports: 1, source: "невідомий" }),
    ])!;
    expect(post.text).toContain("❓ одне джерело");
  });

  it("підтверджене кількома каналами не позначається", () => {
    const post = renderChannelPost([
      threat({ lat: 50.91, lon: 34.8, type: "shahed", reports: 5, confidence: "high" }),
    ])!;
    expect(post.text).not.toContain("❓");
  });

  it("часткова слабкість не позначається — інакше позначка знеціниться", () => {
    // «Частково непідтверджено» читач однаково прочитає як «непідтверджено».
    const post = renderChannelPost([
      threat({ lat: 50.91, lon: 34.8, type: "shahed", reports: 1 }),
      threat({ lat: 50.9, lon: 34.7, type: "shahed", reports: 6, confidence: "high" }),
    ])!;
    expect(post.text).not.toContain("❓");
  });
});

describe("канал не вживає слова «відбій» для власних спостережень", () => {
  it("зникнення цілей над областю описується як «не бачимо», не як відбій", () => {
    const before = renderChannelPost([threat({ lat: 50.91, lon: 34.8, type: "shahed" })])!;
    const after = renderChannelPost([threat({ lat: 49.99, lon: 36.23, type: "shahed" })], {
      previous: before.snapshot,
    })!;
    expect(after.text).toContain("Цілей більше не бачимо");
    expect(after.text).not.toContain("відбій");
  });
});

describe("рядок змін читається однозначно", () => {
  const before = renderChannelPost([threat({ lat: 50.91, lon: 34.8, type: "shahed" })])!;
  const after = renderChannelPost([threat({ lat: 49.23, lon: 28.48, type: "shahed" })], {
    previous: before.snapshot,
  })!;

  it("поява й зникнення — на РІЗНИХ рядках", () => {
    // Склеєні через «·», вони читались навпаки: зелена позначка «цілей не
    // бачимо» опинялась поруч із назвами областей, де цілі щойно зʼявились.
    const appeared = after.text.split("\n").find((l) => l.includes("Зʼявились"))!;
    expect(appeared).not.toContain("не бачимо");
  });

  it("жодного бейджа NEW — Telegram малює його значком, який нічого не каже", () => {
    expect(after.text).not.toContain("🆕");
  });

  it("зникнення цілей не позначається зеленою галочкою — вона читається як відбій", () => {
    expect(after.text).not.toContain("✅");
    expect(after.text).toContain("Цілей більше не бачимо");
  });
});

/*
 * Вилка чесна, але чесність тут не єдина вимога. Коли розкид позиції більший
 * за відстань до міста, нижній край впирається в нуль і виходить «1–29 хв» —
 * твердження формально правдиве й порожнє водночас. У нічному пості порожнє
 * коштує уваги так само, як хибне.
 */
describe("час до міста: вилка, слова або одне число", () => {
  const q = (uncertaintyKm: number, presumptiveCourse = false) => ({
    uncertaintyKm,
    position: "approx" as const,
    lifecycle: "tracking" as const,
    presumptiveCourse,
    speedKmh: null,
  });

  it("розкид більший за відстань — кажемо словами, а не порожнім інтервалом", () => {
    const post = renderChannelPost([
      threat({ lat: 49.3, lon: 34.55, type: "shahed", heading: 0, quality: q(45) }),
    ])!;
    expect(post.text).toContain("може бути вже поруч");
    expect(post.text).not.toMatch(/\(1–\d+ хв\)/);
  });

  it("помірний розкид дає справжню вилку", () => {
    const post = renderChannelPost([
      threat({ lat: 49.0, lon: 34.55, type: "shahed", heading: 0, quality: q(4) }),
    ])!;
    expect(post.text).toMatch(/\(\d+–\d+ хв\)/);
  });

  it("заміряна швидкість і мала невизначеність дають одне число", () => {
    const post = renderChannelPost([
      threat({
        lat: 49.35,
        lon: 34.55,
        type: "shahed",
        heading: 0,
        quality: { ...q(0.5), speedKmh: 185 },
      }),
    ])!;
    expect(post.text).toMatch(/\(~\d+ хв\)/);
  });
});
