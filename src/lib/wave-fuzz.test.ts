/**
 * Фазинг ПОСЛІДОВНОСТЕЙ, а не окремих викликів.
 *
 * Стан живе інакше за чисту функцію: його вади ховаються не в одному виклику, а
 * в ПОРЯДКУ подій — тік із відсталим годинником, зіпсована цифра від джерела,
 * відбій одразу після старту. Тому тут ганяються випадкові ланцюжки переходів,
 * і після кожного кроку перевіряються інваріанти, які мусять триматися завжди.
 *
 * Знайдене цим фазером (усе виправлено в тому ж коміті):
 *
 * — `peakTargets` ставав Infinity. `JSON.parse("1e400")` дає Infinity —
 *   законне число з погляду формату, — і воно текло сумою в знімок, а звідти в
 *   канал рядком «Пік хвилі: Infinity».
 * — `lastActiveAt` і мітки маршруту йшли НАЗАД на тіку з меншим `now`, після
 *   чого `waveEnded` рахував тишу від майбутнього: «цілей не бачимо» могло
 *   вийти в ефір посеред нальоту.
 * — `budgetFor` віддавав NaN, а він вирішує, скільки попереджень узагалі піде:
 *   бюджет у NaN робить кожне `надіслано < бюджет` хибним, тобто мовчки не
 *   надсилає нічого.
 */

import { describe, expect, it } from "bun:test";

import type { ThreatType } from "./air";
import type { AirSnapshot } from "./channel-post";
import {
  beginWave,
  markOfficialAlert,
  renderAllClear,
  renderQuietHold,
  updateWave,
  waveEnded,
  type WaveState,
} from "./channel-wave";
import { budgetFor, orderQueue, timeToReachMs, type Envelope } from "./delivery";

const OBLASTS = ["Київщина", "Харківщина", "Одещина", "Сумщина", "Полтавщина", "м. Київ"];
const TYPES: ThreatType[] = ["shahed", "cruise", "ballistic", "kab", "recon", "unknown"];
/** Числа, які приходять із чужого JSON і виглядають законно. */
const HOSTILE = [0, -1, 1e9, Number.NaN, Infinity];

function makeRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function hostileSnapshot(rnd: () => number): AirSnapshot {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const oblasts: AirSnapshot["oblasts"] = {};
  let targets = 0;
  for (let i = 0; i < Math.floor(rnd() * 5); i++) {
    const o = pick(OBLASTS);
    const m = oblasts[o] ?? {};
    const n = rnd() < 0.3 ? pick(HOSTILE) : 1 + Math.floor(rnd() * 20);
    m[pick(TYPES)] = n;
    oblasts[o] = m;
    if (Number.isFinite(n)) targets += n;
  }
  if (rnd() < 0.2) targets = pick(HOSTILE);
  return { oblasts, targets };
}

function findBad(value: unknown, path: string, out: string[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}`);
    return;
  }
  if (typeof value === "string") {
    if (/NaN|Infinity|undefined/.test(value)) out.push(`${path}: «${value.slice(0, 60)}»`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findBad(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) findBad(v, `${path}.${k}`, out);
  }
}

/** Усе, що мусить триматися після будь-якого кроку. */
function checkInvariants(st: WaveState, prev: WaveState, problems: string[]): void {
  findBad(st, "стан", problems);
  if (st.peakTargets < prev.peakTargets) problems.push("peakTargets зменшився");
  if (prev.officialAlertSeen && !st.officialAlertSeen) problems.push("officialAlertSeen згас");
  if (st.lastActiveAt < prev.lastActiveAt) problems.push("lastActiveAt пішов назад");
  const names = st.route.map((r) => r.oblast);
  if (new Set(names).size !== names.length) problems.push("дублікат області в маршруті");
  const times = st.route.map((r) => r.at);
  if (times.some((v, i) => i > 0 && v < times[i - 1]!))
    problems.push("час у маршруті не монотонний");
}

describe("стан хвилі під випадковими послідовностями", () => {
  it("200 ланцюжків по 25 кроків не ламають жодного інваріанта", () => {
    const rnd = makeRandom(90210);
    const problems: string[] = [];
    for (let run = 0; run < 200 && problems.length === 0; run++) {
      let now = 1_700_000_000_000;
      let st = beginWave(now);
      for (let step = 0; step < 25; step++) {
        now += Math.floor(rnd() * 600_000);
        // Інколи годинник іде НАЗАД: розсинхрон, підміна кешем, переграний тік.
        if (rnd() < 0.08) now -= Math.floor(rnd() * 300_000);
        const prev = st;
        const op = rnd();
        if (op < 0.6) st = updateWave(st, hostileSnapshot(rnd), now);
        else if (op < 0.75)
          st = markOfficialAlert(
            st,
            OBLASTS.filter(() => rnd() < 0.5),
          );
        else if (op < 0.85) waveEnded(st, now);
        else if (op < 0.95) findBad(renderQuietHold(st, ["Київщина"], now), "тиша", problems);
        else findBad(renderAllClear(st, now), "відбій", problems);
        checkInvariants(st, prev, problems);
      }
    }
    expect(problems.slice(0, 3)).toEqual([]);
  });
});

describe("черга доставки під випадковими входами", () => {
  it("упорядкування не губить жодного конверта", () => {
    const rnd = makeRandom(31337);
    const problems: string[] = [];
    for (let run = 0; run < 300; run++) {
      const queue: Envelope<number>[] = Array.from({ length: Math.floor(rnd() * 30) }, (_, i) => ({
        chatId: i,
        priority: Math.floor(rnd() * 5),
        expiresAt: rnd() < 0.2 ? HOSTILE[Math.floor(rnd() * HOSTILE.length)]! : Date.now(),
        payload: i,
      }));
      const ordered = orderQueue(queue);
      if (ordered.length !== queue.length) {
        problems.push(`загублено: ${queue.length} → ${ordered.length}`);
      }
    }
    expect(problems.slice(0, 3)).toEqual([]);
  });

  it("бюджет — завжди скінченне невідʼємне число", () => {
    // Це число вирішує, скільки попереджень узагалі піде. NaN тут не падає —
    // він мовчки не надсилає нічого.
    for (const w of [...HOSTILE, 60_000, -60_000]) {
      for (const p of [...HOSTILE, 30]) {
        const b = budgetFor(w, p);
        expect(Number.isFinite(b) && b >= 0).toBe(true);
      }
    }
  });

  it("час до останнього: нуль на порожній черзі, Infinity лише при нульовій швидкості", () => {
    expect(timeToReachMs(0)).toBe(0);
    expect(timeToReachMs(-5)).toBe(0);
    expect(timeToReachMs(Number.NaN)).toBe(0);
    // Нескінченність тут ЗАКОННА: вона означає «не дійдемо ніколи».
    expect(timeToReachMs(1000, 0)).toBe(Infinity);
    expect(timeToReachMs(1000, 30)).toBeGreaterThan(0);
  });
});
