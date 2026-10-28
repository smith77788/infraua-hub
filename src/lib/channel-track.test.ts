import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import type { Threat } from "./air";
import {
  applyChannelTracks,
  buildTracks,
  channelFixes,
  isEndOfTarget,
  mentionsOf,
} from "./channel-track";
import { Gazetteer } from "./gazetteer";

const gaz = new Gazetteer(readFileSync("assets/geo/ua-places.tsv", "utf8"));
const NOW = Date.parse("2026-10-21T17:45:00Z");

// Дослівні дописи RADAR.RIVNE (radarrv2025), 2026-10-21, хвилини до NOW.
const RIVNE: [number, string][] = [
  [14, "Маневр на Зв'ягель"],
  [12, "Скинув висоту, Корець Гоща уважно"],
  [10, "Залітає в напрямку Весняне"],
  [10, "Даничів"],
  [9, "Великі Межиричі"],
  [7, "Самостріли/Бокшин"],
  [6, "Баранів/Федорівка"],
  [6, "Гоща"],
  [5, "Далі Бабин"],
  [4, "Відвернув на Бугрин"],
  [3, "Підліски"],
  [2, "М'ятин/Глинки"],
];
const msgs = RIVNE.map(([m, text]) => ({ at: NOW - m * 60_000, text, channel: "radarrv2025" }));

describe("mentionsOf — що каже допис", () => {
  it("допис лише з назв — позиція; дві назви через «/» — обидві", () => {
    expect(mentionsOf("Гоща", gaz).map((m) => m.kind)).toEqual(["position"]);
    expect(mentionsOf("Самостріли/Бокшин", gaz)).toHaveLength(2);
  });

  it("«Далі X», «повз X» — позиція; «Відвернув на X», «курсом на X», «→ X» — курс", () => {
    expect(mentionsOf("Далі Бабин", gaz)[0]!.kind).toBe("position");
    expect(mentionsOf("🛵 Реактивний повз Гощу на Рівне", gaz)[0]).toMatchObject({
      kind: "position",
      said: "Гощу",
    });
    expect(mentionsOf("Відвернув на Бугрин", gaz)[0]!.kind).toBe("course");
    expect(mentionsOf("Львів: Реактивний БпЛА курсом на Виннички", gaz)[0]!.kind).toBe("course");
    expect(mentionsOf("Волинська область ◦ Реактивний → Колки", gaz)[0]!.kind).toBe("course");
  });

  it("попередження районам — не точка: «Скинув висоту, Корець Гоща уважно»", () => {
    expect(mentionsOf("Скинув висоту, Корець Гоща уважно", gaz)).toHaveLength(0);
  });

  it("чого немає в довіднику — не вгадуємо: «Баранів/Федорівка» не дає точки", () => {
    expect(mentionsOf("Баранів/Федорівка", gaz)).toHaveLength(0);
  });
});

describe("трек RADAR.RIVNE — із дописів у ціль на карті", () => {
  const fixes = channelFixes(msgs, gaz, [], NOW);
  const tracks = buildTracks(fixes);

  it("сім точок зшито в один трек", () => {
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.fixes.map((f) => f.said)).toEqual([
      "Даничів",
      "Великі Межиричі",
      "Самостріли/Бокшин",
      "Гоща",
      "Бабин",
      "Підліски",
      "М'ятин/Глинки",
    ]);
  });

  it("Нептун мовчить — канал веде: нова ціль, курс спостережений (на захід)", () => {
    const out = applyChannelTracks([], tracks);
    expect(out).toHaveLength(1);
    const t = out[0]!;
    expect(t.source).toBe("radarrv2025");
    expect(t.quality!.presumptiveCourse).toBe(false);
    expect(t.heading!).toBeGreaterThan(240);
    expect(t.heading!).toBeLessThan(290);
    expect(t.trail).toHaveLength(7);
    // Тип канал не назвав — не вигадуємо «шахед».
    expect(t.type).toBe("unknown");
  });

  it("є ціль джерела поруч і вона давніша — позначка переїжджає в точку каналу", () => {
    const stale: Threat = {
      id: "n1",
      name: "Гоща",
      lat: 50.6,
      lon: 26.68,
      source: "neptun.in.ua",
      count: 1,
      since: new Date(NOW - 15 * 60_000).toISOString(),
      expires: "",
      type: "reactive",
    };
    const out = applyChannelTracks([stale], tracks);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("n1");
    expect(out[0]!.name).toBe("М'ятин/Глинки");
    expect(out[0]!.type).toBe("reactive"); // тип джерела не губимо
    expect(out[0]!.sources).toContain("radarrv2025");
  });

  it("ціль джерела свіжіша за останню точку каналу — не чіпаємо", () => {
    const fresh: Threat = {
      id: "n2",
      name: "Рівне",
      lat: 50.58,
      lon: 26.42,
      source: "neptun.in.ua",
      count: 1,
      since: new Date(NOW).toISOString(),
      expires: "",
      type: "shahed",
    };
    expect(applyChannelTracks([fresh], tracks)[0]!.lat).toBe(50.58);
  });

  it("одна точка без цілі поруч — нової цілі не створює", () => {
    const one = buildTracks(channelFixes([msgs[3]!], gaz, [], NOW));
    expect(applyChannelTracks([], one)).toHaveLength(0);
  });

  it("назва позначки — у називному: «над Вільнянськом» → «Вільнянськ», «М'ятин» лишається з апострофом", () => {
    const f = channelFixes(
      [{ at: NOW - 60_000, text: "Над Вільнянськом", channel: "c" }],
      gaz,
      [],
      NOW,
    );
    expect(f[0]!.place.name).toBe("Вільнянськ");
    expect(f[0]!.said).toBe("Вільнянськом");
    expect(fixes.find((x) => x.said === "М'ятин/Глинки")!.place.name).toBe("М'ятин/Глинки");
    // GeoNames: «Дубровіца»; канал пише правильно — лишаємо як у дописі.
    const near: Threat = {
      id: "n3",
      name: "Дубровиця",
      lat: 51.55,
      lon: 26.6,
      source: "neptun.in.ua",
      count: 1,
      since: "",
      expires: "",
    };
    const d = channelFixes(
      [{ at: NOW - 60_000, text: "Дубровиця", channel: "c" }],
      gaz,
      [near],
      NOW,
    );
    expect(d[0]!.place.name).toBe("Дубровиця");
  });

  it("однойменні пункти: «Підліски» (5 в Україні) — саме рівненські, біля треку", () => {
    const p = fixes.find((f) => f.said === "Підліски")!;
    expect(p.place.admin).toBe("19");
  });

  it("курс — від попередньої точки, що вже за ≥ 3 км, а не від сусідньої", () => {
    // Дві останні точки за кілометр — курс між ними був би шумом.
    const near = [
      { at: NOW - 6 * 60_000, text: "Гоща", channel: "c" },
      { at: NOW - 3 * 60_000, text: "Мʼятин", channel: "c" },
      { at: NOW - 2 * 60_000, text: "Глинки", channel: "c" },
    ];
    const out = applyChannelTracks([], buildTracks(channelFixes(near, gaz, [], NOW)));
    expect(out[0]!.heading!).toBeGreaterThan(240);
    expect(out[0]!.heading!).toBeLessThan(290);
  });
});

describe("кінець цілі — «зникла» закриває трек", () => {
  // Дослівно shovnebi, 22.10.2026, хвилини до 17:55 UTC.
  const AT = Date.parse("2026-10-22T17:55:00Z");
  const SHOV: [number, string][] = [
    [20, "Фпв південніше Вільнянська в районі Яковлеве"],
    [18, "над Вільнянськом в бік жд вокзалу"],
    [17, "над Вільнянськом в бік жд вокзалу"],
    [16, "зникла"],
  ];
  const m = SHOV.map(([min, text]) => ({ at: AT - min * 60_000, text, channel: "shovnebi" }));

  it("коротка фраза-кінець — так; продовження розповіді — ні", () => {
    for (const t of ["зникла", "Мінус", "мінус 1", "Збито!", "✅ Відбій", "сбит"]) {
      expect(isEndOfTarget(t)).toBe(true);
    }
    for (const t of ["мінус 2, ще 3 на Київ", "зникла з радарів, але ще одна на Гощу", "Гоща"]) {
      expect(isEndOfTarget(t)).toBe(false);
    }
  });

  it("після «зникла» ціль із каналу не лишається на карті", () => {
    const tracks = buildTracks(channelFixes(m, gaz, [], AT));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.ended).toBe(true);
    expect(applyChannelTracks([], tracks)).toHaveLength(0);
  });

  it("без «зникла» — та сама ціль є, підписана в називному: «Вільнянськ»", () => {
    const out = applyChannelTracks([], buildTracks(channelFixes(m.slice(0, 3), gaz, [], AT)));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Вільнянськ");
  });

  it("наступна ціль каналу після «зникла» — не продовження старої", () => {
    const next = [
      ...m,
      { at: AT - 6 * 60_000, text: "далі Петропавлівка", channel: "shovnebi" },
      { at: AT - 5 * 60_000, text: "Самарське далі", channel: "shovnebi" },
    ];
    const tracks = buildTracks(channelFixes(next, gaz, [], AT));
    // Стара ціль закрита й нічого не набрала після «зникла».
    expect(tracks[0]!.ended).toBe(true);
    expect(tracks[0]!.fixes.map((f) => f.said)).not.toContain("Петропавлівка");
    // Без опори «Петропавлівок» багато — точки не вгадуємо (раніше опорою
    // ставав Вільнянськ, і обиралась запорізька замість дніпропетровської).
    expect(tracks.slice(1).flatMap((t) => t.fixes.map((f) => f.said))).not.toContain(
      "Петропавлівка",
    );
  });
});

describe("списки агрегаторів і підтвердження кількома каналами (дослівно, 23.10.2026)", () => {
  const AT = Date.parse("2026-10-23T00:30:00Z");
  // sectorv666 і Ukrainian_Intelligence — той самий список.
  const LIST =
    "Рівненщина : реактивний на Млинів\n\nЧернігівщина : реактивний на Славутич\n\nЖитомирщина : звичайний біля Ружина (100м)";

  it("рядок — окрема ціль: область із заголовка, тип із рядка", () => {
    const f = channelFixes([{ at: AT - 60_000, text: LIST, channel: "a" }], gaz, [], AT);
    const ruzhyn = f.find((x) => x.kind === "position")!;
    expect(ruzhyn.place.name).toBe("Ружин");
    // Житомирщина, а не «Ружино» на Миколаївщині.
    expect(ruzhyn.place.lat).toBeGreaterThan(49.5);
    expect(ruzhyn.type).toBe("shahed"); // «звичайний», хоч допис і про реактивні
    const courses = f.filter((x) => x.kind === "course");
    expect(courses.map((x) => x.type)).toEqual(["reactive", "reactive"]);
  });

  it("одна точка від двох каналів — ціль; від одного — ні", () => {
    const one = buildTracks(
      channelFixes([{ at: AT - 60_000, text: LIST, channel: "a" }], gaz, [], AT),
    );
    expect(applyChannelTracks([], one)).toHaveLength(0);
    const two = buildTracks(
      channelFixes(
        [
          { at: AT - 120_000, text: LIST, channel: "sectorv666" },
          { at: AT - 60_000, text: LIST, channel: "Ukrainian_Intelligence" },
        ],
        gaz,
        [],
        AT,
      ),
    );
    const out = applyChannelTracks([], two);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Ружин", type: "shahed" });
    expect(out[0]!.sources).toEqual(
      expect.arrayContaining(["sectorv666", "Ukrainian_Intelligence"]),
    );
  });

  it("«пройшов Городню» → «після Ріпок» — дві точки, трек (UkraineRadar_24_7)", () => {
    const msgs = [
      {
        at: AT - 9 * 60_000,
        text: "⚠️ Реактивний на Чернігівщині пройшов Городню, далі курсом на Ріпки.",
        channel: "UkraineRadar_24_7",
      },
      {
        at: AT - 2 * 60_000,
        text: "⚠️ Реактивний на Чернігівщині після Ріпок змінив курс, тепер на Славутич.",
        channel: "UkraineRadar_24_7",
      },
    ];
    const tracks = buildTracks(channelFixes(msgs, gaz, [], AT));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.fixes.map((f) => f.place.name)).toEqual(["Городня", "Ріпки"]);
    const [t] = applyChannelTracks([], tracks);
    expect(t).toMatchObject({ type: "reactive", name: "Ріпки" });
  });

  it("«Чернігівщина - чисто» — стан області, а не село Чисте", () => {
    expect(mentionsOf("Чернігівщина - чисто", gaz)).toHaveLength(0);
    expect(mentionsOf("Поки тихо", gaz)).toHaveLength(0);
  });

  it("дві цілі одного каналу в різних областях не рвуть треки одна одній", () => {
    const msgs = [
      { at: AT - 8 * 60_000, text: "Гоща", channel: "c" },
      { at: AT - 7 * 60_000, text: "Чернігівщина: Ріпки", channel: "c" },
      { at: AT - 5 * 60_000, text: "Далі Бабин", channel: "c" },
      { at: AT - 4 * 60_000, text: "Чернігівщина: Любеч", channel: "c" },
    ];
    const tracks = buildTracks(channelFixes(msgs, gaz, [], AT));
    expect(tracks.map((t) => t.fixes.length)).toEqual([2, 2]);
  });
});

describe("дорозвідка — перевірка неба, а не ціль", () => {
  /*
   * Зауважив користувач: на карті побільшало цілей там, де їх не мало бути.
   * Канали пишуть «дорозвідка» про ПОВТОРНИЙ огляд після збиття чи падіння —
   * тобто слово означає протилежне появі цілі.
   */
  it("«Дорозвідка в районі Гощі» більше не ставить ціль у Гощі", () => {
    // Заміряно до виправлення: давало position:Гоща — фантом саме там, де
    // небо щойно перевіряли на чистоту. STATUS_WORDS цього не ловили, бо
    // прив'язані до цілого рядка, а тут спрацьовував POSITION_CUE «в районі».
    expect(mentionsOf("Дорозвідка в районі Гощі", gaz)).toHaveLength(0);
  });

  it("інші форми слова теж не дають цілі", () => {
    for (const t of ["Дорозвідка", "Дорозвідка Рівне", "Дорозвідка неба над Рівним"]) {
      expect(mentionsOf(t, gaz)).toHaveLength(0);
    }
  });

  it("ГОЛОВНЕ: якщо дорозвідка когось ЗНАЙШЛА — ціль лишається", () => {
    /*
     * Межа навмисно вузька. Глушити рядок можна лише там, де апарат не
     * названо: інакше ми сховали б ціль, яку перевірка й виявила. Помилка
     * тут мусить бути в бік показу загрози, а не замовчування.
     */
    const m = mentionsOf("Дорозвідка: реактивний повз Гощу", gaz);
    expect(m).toHaveLength(1);
    expect(m[0]!.lineType).toBe("reactive");
  });

  it("звичайна ціль без цього слова не зачеплена", () => {
    expect(mentionsOf("Реактивний повз Гощу на Рівне", gaz)).toHaveLength(1);
  });
});

describe("назва краю в рубриці списку — не пункт", () => {
  /*
   * Користувач: «наша карта показує набагато більше цілей, ніж Нептун».
   * Заміряно 25.10 на 4453 рядках свіжих дописів 111 каналів: заголовок
   * «Буковина» 12 разів ставав СЕЛОМ Буковина, з п'яти різних каналів — і
   * однакова помилка кількох каналів зараховувалась як підтвердження.
   */
  it("рядок із самою назвою краю цілі не дає — у будь-якому оформленні", () => {
    for (const t of [
      "🛵 Буковина",
      "✈️ Буковина:",
      "Буковина:",
      "Харківщина:",
      "Київська область",
    ]) {
      expect(mentionsOf(t, gaz)).toHaveLength(0);
    }
  });

  it("дослівний допис агрегатора більше не ставить фантом у селі Буковина", () => {
    // До виправлення: position:Буковина — і нічого більше.
    const m = mentionsOf("🛵 Буковина\n - 2 на керованих Новодністровськ", gaz);
    expect(m.some((x) => x.places.some((p) => p.name === "Буковина"))).toBe(false);
  });

  it("обласний центр — не рубрика, а пункт", () => {
    // `oblastAdminIn` впізнає лише «-щина»/«-ська»/«Буковина», а не назву
    // міста: «Херсон» лишається позицією.
    expect(mentionsOf("Херсон", gaz).map((x) => x.kind)).toEqual(["position"]);
    expect(mentionsOf("Гоща", gaz).map((x) => x.kind)).toEqual(["position"]);
  });

  it("рубрика з вмістом після двокрапки працює як раніше", () => {
    // «Рівненщина: Гоща» — заголовок звужує вибір, а пункт лишається.
    expect(mentionsOf("Рівненщина: Гоща", gaz).map((x) => x.kind)).toEqual(["position"]);
  });
});

describe("неназваний апарат поруч із ціллю джерела будь-якого типу — не нова ціль", () => {
  /*
   * Заміряно 25.10: 50 хв, 25 зрізів конвеєра консолі проти живого Нептуна.
   * «Шахтарське — 0 км від цілі Нептуна», «Зарічне — 5 км»: одна подія, дві
   * позначки. Зливаємо лише з дронами, тож поруч із FPV чи КАБом допис каналу
   * без названого апарата ставав окремою ціллю.
   */
  const fixes = channelFixes(msgs, gaz, [], NOW);
  const tracks = buildTracks(fixes);
  const fpvAtHoshcha: Threat = {
    id: "n-fpv",
    name: "Гоща",
    lat: 50.6,
    lon: 26.68,
    source: "neptun.in.ua",
    count: 1,
    since: new Date(NOW - 15 * 60_000).toISOString(),
    expires: "",
    type: "fpv",
  };

  it("до виправлення тут було дві цілі — тепер одна, і це ціль джерела", () => {
    expect(tracks[0]!.type).toBe("unknown");
    const out = applyChannelTracks([fpvAtHoshcha], tracks);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("n-fpv");
  });

  it("позицію FPV точкою села з допису не перезаписуємо", () => {
    const out = applyChannelTracks([fpvAtHoshcha], tracks);
    expect(out[0]!.lat).toBe(50.6);
    expect(out[0]!.type).toBe("fpv");
  });

  it("НАЗВАНИЙ шахед поруч із FPV лишається окремою ціллю — це можуть бути двоє", () => {
    const named = tracks.map((t) => ({ ...t, type: "shahed" as const }));
    expect(applyChannelTracks([fpvAtHoshcha], named)).toHaveLength(2);
  });

  it("без цілей поруч канал, як і раніше, веде ціль сам", () => {
    expect(applyChannelTracks([], tracks)).toHaveLength(1);
  });
});

describe("не-пункти з живих дописів: звичайні слова, області, новини, райони", () => {
  /*
   * Заміряно 25.10 на 1890 дописах 111 каналів: усі остаточні точки до й після
   * цих правил, поштучно. Зникло 17, не з'явилось жодної. Шістнадцять — сміття
   * (кожне нижче — дослівний рядок); одна справжня («Шахед на черноморск», з
   * малої) — заміряна ціна правила про регістр.
   */
  const saids = (t: string) => mentionsOf(t, gaz).map((m) => m.said);

  it("звичайне слово з малої літери — не село («після атаки», «через південь»)", () => {
    expect(saids("Синельникове оговтується після вечірньої атаки російського дрона")).not.toContain(
      "атаки",
    );
    expect(saids("Реактивний БпЛА через південь області на Кривий Ріг")).not.toContain("південь");
  });

  it("назва області — не село Харківщина в Сумській області", () => {
    const m = saids("2 реактиви на Харківщині у бік Полтави");
    expect(m).not.toContain("Харківщині");
  });

  it("обласні центри й міста-тезки прикметникових основ не зачеплені", () => {
    // «Хмельницький», «Донецьк» — основи «-цьк», а не назви областей.
    expect(saids("Реактивний БпЛА курсом на Хмельницький")).toContain("Хмельницький");
  });

  it("новина без жодного апарата — не зведення, навіть із назвою в окремому рядку", () => {
    // Дослівно eRadarrua, 25.10: рядок-дата «Краматорськ» ставав ціллю.
    const report =
      "Краматорськ\n25 жовтня 2026 року\n\nВнаслідок постійних ворожих обстрілів місто поступово перетворюється на руїни. Вулиці практично порожні, житловий фонд та інфраструктура зазнають щоденних руйнувань від ₚосійського терору.\n\n#russiaisaterroriststate\n\n@eRadarrua";
    expect(report.length).toBeGreaterThanOrEqual(250);
    expect(mentionsOf(report, gaz)).toHaveLength(0);
  });

  it("сигнальне слово в довгій новині не ставить ціль («в районі Олешків»)", () => {
    // Дослівно place_kharkiv, 25.10. «Олешків» до того ж знаходився не в
    // Херсонській, а в Івано-Франківській області.
    const news =
      "Американська сторона запропонувала розпочати режим тиші в районі Олешків з 27 жовтня, повідомив президент Володимир Зеленський.\n\nРежим тиші триватиме кілька днів, приїдуть гуманітарні місії США, України та РФ.\n\nРосіяни повинні розмінувати дороги. Водночас, за словами Зеленського, росіяни робитимуть усе, щоб розмінувати лише ті дороги, що ведуть в бік Росії.";
    expect(news.length).toBeGreaterThanOrEqual(250);
    expect(saids(news)).not.toContain("Олешків");
  });

  it("ГОЛОВНЕ: короткий справжній допис без названого апарата лишається", () => {
    // «Тупо транзит над Києвом» — 54 символи, апарат не названо, і це зведення.
    expect(saids("Тупо транзит над Києвом, щоб вилетіти на Житомирщину 👍")).toContain("Києвом");
  });

  it("довгий список агрегатора, де апарат названо в рядку, лишається цілком", () => {
    const list =
      "Київщина:\nРеактивний БпЛА курсом на Бровари\nРеактивний БпЛА курсом на Гостомель\n\n" +
      "Житомирщина:\nРеактивний БпЛА курсом на Коростишів\n2х Реактивні БпЛА курсом на Народичі\n\n" +
      "Одещина:\nРеактивний БпЛА курсом на Любашівку\nРеактивний БпЛА курсом на Роздільну\n\n" +
      "Вінниччина:\nРеактивний БпЛА курсом на Крижопіль";
    expect(list.length).toBeGreaterThanOrEqual(250);
    expect(mentionsOf(list, gaz).length).toBeGreaterThanOrEqual(6);
  });

  it("район і хештег з оголошення тривоги — територія й тег, а не ціль", () => {
    expect(mentionsOf("🟢 08:39 Відбій тривоги в\n• Кальміуський район", gaz)).toHaveLength(0);
    expect(mentionsOf("#Дніпровський_район", gaz)).toHaveLength(0);
  });
});

describe("одиночна точка каналу спостереження (PhantomChe, 27.10.2026)", () => {
  const AT = Date.parse("2026-10-27T23:40:00Z");
  const JET = {
    at: AT - 3 * 60_000,
    text: "Новий реактивний від Брянської, попередньо, під кордоном повз Славутич на Київщину.",
    channel: "PhantomChe",
  };
  const watch = { trusted: (c: string) => c === "PhantomChe", now: AT };

  it("канал спостереження, тип названо, свіжа — ціль із позначкою «одне джерело»", () => {
    const out = applyChannelTracks([], buildTracks(channelFixes([JET], gaz, [], AT)), watch);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Славутич", type: "reactive", sources: ["PhantomChe"] });
    expect(out[0]!.quality).toMatchObject({ lifecycle: "uncertain", uncertaintyKm: 15 });
  });

  it("без правила, з не-спостережного каналу або старша за 10 хв — нічого", () => {
    const tracks = buildTracks(channelFixes([JET], gaz, [], AT));
    expect(applyChannelTracks([], tracks)).toHaveLength(0);
    expect(applyChannelTracks([], tracks, { trusted: () => false, now: AT })).toHaveLength(0);
    expect(applyChannelTracks([], tracks, { ...watch, now: AT + 15 * 60_000 })).toHaveLength(0);
  });

  it("тип не названо — одиночна точка не стає ціллю", () => {
    const plain = { ...JET, text: "Повз Славутич" };
    const tracks = buildTracks(channelFixes([plain], gaz, [], AT));
    expect(applyChannelTracks([], tracks, watch)).toHaveLength(0);
  });

  it("«в районі Ріпки/Олешня» — пара назв вибирає ті, що поруч (Чернігівщина)", () => {
    const f = channelFixes(
      [
        {
          at: AT - 60_000,
          text: "Ще звич.дрон під кордоном в районі Ріпки/Олешня.",
          channel: "PhantomChe",
        },
      ],
      gaz,
      [],
      AT,
    );
    const p = f.find((x) => x.kind === "position")!;
    expect(p.place.admin).toBe("02");
    expect(p.type).toBe("shahed");
  });
});

describe("курс — на захід, а не на північ (monikppy, 28.10.2026)", () => {
  const AT = Date.parse("2026-10-28T21:36:00Z");
  const msgs = [
    {
      at: AT - 18 * 60_000,
      text: "⚠️ Київщина:\n2х Реактивних повз Чорнобиль",
      channel: "monikppy",
    },
    {
      at: AT - 7 * 60_000,
      text: "⚠️ Житомирщина:\nРеактивний на Овруч\nРеактивний повз Овруч у Рівненську область",
      channel: "monikppy",
    },
  ];

  it("«на Овруч» у самому Овручі курсу не дає; «у Рівненську область» — дає захід", () => {
    const tracks = buildTracks(channelFixes(msgs, gaz, [], AT));
    const out = applyChannelTracks([], tracks);
    const ovruch = out.find((t) => t.name === "Овруч")!;
    expect(ovruch).toBeDefined();
    // Рівне від Овруча — на захід-південний захід; північ (≈0°) — неправда.
    expect(ovruch.heading!).toBeGreaterThan(220);
    expect(ovruch.heading!).toBeLessThan(290);
  });

  it("область як напрямок: «у Рівненську область», «на Київщину», «в бік Волині» — так; заголовок, «на Полтавщині», «з Брянщини» — ні", async () => {
    const { oblastDirectionIn } = await import("./oblast");
    expect(oblastDirectionIn("повз Овруч у Рівненську область")).not.toBeNull();
    expect(oblastDirectionIn("7 реактивів на Київщину")).not.toBeNull();
    expect(oblastDirectionIn("далі в бік Волині")).not.toBeNull();
    expect(oblastDirectionIn("Житомирщина: Реактивний на Овруч")).toBeNull();
    expect(oblastDirectionIn("Реактивний на Полтавщині повернув")).toBeNull();
    expect(oblastDirectionIn("Новий реактивний з Брянщини")).toBeNull();
  });
});

describe("«Запоріжжя:» — рубрика, а не село на Київщині (monikppy, 28.10.2026)", () => {
  it("рядок із двокрапкою в кінці пунктом не стає", () => {
    expect(mentionsOf("Запоріжжя:", gaz)).toHaveLength(0);
    const ms = mentionsOf("Запоріжжя:\nБПЛА на Кушу", gaz);
    expect(ms.every((m) => m.kind === "course")).toBe(true);
  });
});
