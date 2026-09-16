/**
 * Фазинг ядра радара: вироджені дані не мають народжувати нечисла.
 *
 * Тести на прикладах перевіряють те, про що ми подумали. Цей — те, про що не
 * подумали. Він ганяє через увесь ланцюг (оцінка → рівень → міста на курсі →
 * адресний сигнал → пост у канал → рух → коло застою) випадкові й навмисно
 * зіпсовані цілі: координати на полюсі й за межами світу, курс у 720°,
 * швидкість у мільярд, розкид у NaN, час у «не дата» й у завтрашній день.
 *
 * Вимога одна й сувора: НІ ВИНЯТКУ, НІ NaN, НІ Infinity у виході. Причина не
 * в охайності. Радіус у NaN не падає й не помітний: він тихо робить NaN усю
 * вилку часу підльоту, а кожне порівняння з NaN хибне — тож рішення «будити»
 * просто перестає спрацьовувати. Мовчазна відмова коштує рівно стільки ж, як
 * ненадіслане сповіщення.
 *
 * Так і знайшлась вада в `displayRadiusKm`, яку 1300 тестів на прикладах не
 * бачили.
 *
 * Насіння стале — падіння відтворюється, а не «іноді».
 */

import { describe, expect, it } from "bun:test";

import type { Threat, ThreatType } from "./air";
import { dangerIndex, personalAssessment } from "./advisory";
import { renderChannelPost } from "./channel-post";
import { ALERT_CITIES, cityAlertCaption, cityAlerts } from "./city-alert";
import { nowRadiusKm } from "./position-age";
import { citiesOnCourse } from "./threat-eta";
import { estimateMotion } from "./track-filter";

const NOW = Date.parse("2026-09-16T21:07:58Z");
const POINT = { lat: 50.45, lon: 30.52 };

const WEIRD_NUM = [0, -0, 1e-12, 1e12, -1e12, 90, -90, 180, -180, 360, 720, -720, NaN, Infinity];
const WEIRD_TIME = ["", "не дата", "2026-13-45T99:99:99Z", new Date(NOW + 864e5).toISOString(), ""];
const TYPES: (ThreatType | undefined)[] = [
  "shahed",
  "reactive",
  "cruise",
  "missile",
  "ballistic",
  "kab",
  "recon",
  "aircraft",
  "unknown",
  undefined,
];

function makeRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function weirdThreat(rnd: () => number, i: number): Threat {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const broken = rnd() < 0.4;
  const t: Threat = {
    id: `f${i}`,
    name: pick(["", "Ціль", "<b>x</b>", "я".repeat(300)]),
    lat: broken ? pick(WEIRD_NUM) : 44 + rnd() * 8,
    lon: broken ? pick(WEIRD_NUM) : 22 + rnd() * 18,
    source: pick(["neptun.in.ua", "", "x"]),
    count: broken ? pick([0, -5, 1e9, NaN]) : 1 + Math.floor(rnd() * 5),
    since: pick(WEIRD_TIME),
    expires: pick(WEIRD_TIME),
    ...(pick(TYPES) !== undefined ? { type: pick(TYPES) as ThreatType } : {}),
  };
  if (rnd() < 0.7) t.heading = broken ? pick(WEIRD_NUM) : rnd() * 360;
  if (rnd() < 0.6) t.lastSeen = pick(WEIRD_TIME);
  if (rnd() < 0.6) {
    t.quality = {
      uncertaintyKm: broken ? pick([0, -10, 1e9, NaN, null]) : Math.round(rnd() * 40),
      position: pick(["confirmed", "approx", null] as const),
      lifecycle: pick(["uncertain", "tracking", "confirmed", null] as const),
      presumptiveCourse: rnd() < 0.8,
      speedKmh: broken ? pick([0, -100, 1e9, NaN, null]) : Math.round(rnd() * 900),
    };
  }
  if (rnd() < 0.3) {
    t.trail = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
      lat: 44 + rnd() * 8,
      lon: 22 + rnd() * 18,
      t: pick(WEIRD_TIME),
    }));
  }
  return t;
}

/** Шукає нечисла й сліди нечисел у тексті всюди в результаті. */
function findBad(value: unknown, path: string, out: string[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}`);
    return;
  }
  if (typeof value === "string") {
    if (/NaN|Infinity|undefined/.test(value)) out.push(`${path} містить «${value.slice(0, 60)}»`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findBad(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      // `threat`/`facility` — це вхід, покладений у вихід; його вже перевірили.
      if (k === "threat" || k === "facility") continue;
      findBad(v, `${path}.${k}`, out);
    }
  }
}

describe("ядро радара на вироджених даних", () => {
  const stages: [string, (threats: Threat[]) => unknown][] = [
    ["personalAssessment", (t) => personalAssessment(t, POINT, { radiusKm: 100, now: NOW })],
    ["dangerIndex", (t) => dangerIndex(personalAssessment(t, POINT, { radiusKm: 100, now: NOW }))],
    ["citiesOnCourse", (t) => t.map((x) => citiesOnCourse(x, ALERT_CITIES, {}))],
    ["cityAlerts", (t) => cityAlerts(t)],
    ["cityAlertCaption", (t) => cityAlerts(t).map((a) => cityAlertCaption(a))],
    ["renderChannelPost", (t) => renderChannelPost(t, { now: NOW })],
    ["nowRadiusKm", (t) => t.map((x) => nowRadiusKm(x, NOW))],
    [
      "estimateMotion",
      (t) =>
        t.map((x) =>
          estimateMotion(
            (x.trail ?? []).map((p) => ({ lat: p.lat, lon: p.lon, ts: Date.parse(p.t) || NOW })),
            NOW,
            ...(x.type ? [{ type: x.type }] : []),
          ),
        ),
    ],
  ];

  for (const [name, run] of stages) {
    it(`${name}: ні винятку, ні NaN на 200 випадкових наборах`, () => {
      const rnd = makeRandom(20260916);
      const problems: string[] = [];
      for (let round = 0; round < 200; round++) {
        const threats = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) =>
          weirdThreat(rnd, round * 10 + i),
        );
        let result: unknown;
        try {
          result = run(threats);
        } catch (error) {
          problems.push(`раунд ${round}: виняток ${(error as Error).message.slice(0, 80)}`);
          continue;
        }
        const bad: string[] = [];
        findBad(result, "", bad);
        if (bad.length) problems.push(`раунд ${round}: ${bad[0]}`);
      }
      expect(problems.slice(0, 3)).toEqual([]);
    });
  }
});
