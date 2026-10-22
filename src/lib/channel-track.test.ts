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
