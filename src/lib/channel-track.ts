import { classifyThreatType, type Threat, type ThreatType } from "./air";
import { type Gazetteer, type GeoPlace, normName } from "./gazetteer";
import { distanceKm } from "./infra-types";
import type { ChannelMessage } from "./jet-sightings";
import { bearingDeg } from "./threat-eta";

/**
 * Трек цілі з дописів каналів — коли спостерігач веде її по селах.
 *
 * ## Що бачили і чого не ловили
 *
 * RADAR.RIVNE (2026-10-21, живий зріз): «Даничів» → «Великі Межиричі» →
 * «Самостріли/Бокшин» → «Гоща» → «Далі Бабин» → «Відвернув на Бугрин» →
 * «Підліски» → «Мʼятин/Глинки» — точка щохвилини, з точним часом. Система
 * брала позицію лише з Нептуна, який веде позначку по населених пунктах і
 * рухає її рідше (findings #116: 36 із 37 цілей не зрушили за 6,5 хв). А в
 * розборі удару по Рівному 19.10 (#108) Нептун не мав цілі зовсім, хоча той
 * самий канал вів її 16 хвилин поіменно.
 *
 * ## Що розуміємо
 *
 *  - ПОЗИЦІЯ: допис лише з назв («Гоща», «Самостріли/Бокшин»), «Далі X»,
 *    «повз X», «біля X», «над X», «в районі X», «у передмісті X»;
 *  - КУРС: «Відвернув/повернув на X», «маневр на X», «курсом на X», «в
 *    напрямку X», «в бік X», «→ X». Курс НЕ рухає позначку — лише каже, куди.
 *
 * Допис, де поряд із назвою є інші слова без такої підказки («Скинув висоту,
 * Корець Гоща уважно»), позиції не дає: це попередження районам, а не точка.
 *
 * ## Неоднозначність — за близькістю, інакше мовчимо
 *
 * «Федорівок» в Україні 63. Обираємо збіг, найближчий до опори: поточних
 * цілей і попередньої точки того ж каналу; далі `MAX_ANCHOR_KM` — не беремо.
 * Без опори назва має бути єдиною в довіднику. Чого немає в довіднику
 * («Баранів») — того не вгадуємо.
 */

export interface ChannelFix {
  channel: string;
  at: number;
  /** `end` — канал сказав, що ціль зникла / збита: трек закрито. */
  kind: "position" | "course" | "end";
  place: GeoPlace;
  /** Назва так, як її написав канал. */
  said: string;
  type: ThreatType;
}

/** Скільки свіжою має бути точка: далі — це вже історія, а не де ціль. */
export const FIX_WINDOW_MS = 20 * 60_000;
/** Найдальша опора, від якої ще можна вибрати один із однойменних пунктів. */
export const MAX_ANCHOR_KM = 80;
/** Дві точки одного каналу — одна ціль, якщо між ними правдоподібний політ. */
const MAX_LINK_GAP_MS = 15 * 60_000;
const MAX_LINK_KMH = 900;
/** Точку каналу приписуємо цілі Нептуна, якщо вона не далі за це. */
export const MATCH_TARGET_KM = 45;

const POSITION_CUE =
  /(?:^|[\s,.:;(])(?:далі|дали|повз|біля|возле|над|в районі|у районі|в районе|в передмісті|у передмісті|поблизу|через)\s+(.+)$/i;
const COURSE_CUE =
  /(?:^|[\s,.:;(])(?:відвернув на|повернув на|розвернувся на|маневр на|курсом на|курс на|в напрямку|у напрямку|в направлении|в бік|у бік|в сторону|→|->)\s*(.+)$/i;

/**
 * Кінець цілі: короткий допис «зникла», «мінус», «збито», «відбій». Лише
 * короткий — «мінус 2, ще 3 на Київ» продовжує розповідь, а не закриває її.
 * Заміряно на shovnebi, 22.10: «над Вільнянськом» → «зникла» о 17:39, а ціль
 * трималась на карті ще 17 хв і до неї причепився інший FPV за 25 км.
 */
const END_CUE =
  /^(?:зникл[аио]?|зник|пропал[аио]?|мінус|минус|збит[аоиі]й?|збили|знищен[аоиі]й?|уничтожен[аоы]?|сбит[аоы]?|ціль втрачена|втратили|відбій|отбой)(?=$|[\s!.,)])/i;

/** Допис закриває трек: коротка фраза-кінець, без назв і продовження. */
export function isEndOfTarget(text: string): boolean {
  const line = text
    .replace(/[^\p{L}\p{N}\s'’ʼ-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.split(" ").length <= 3 && END_CUE.test(line);
}

/** Службові слова, що не заважають «допису лише з назв». */
const FILLER = new Set([
  "і",
  "й",
  "та",
  "и",
  "далі",
  "дали",
  "ще",
  "1",
  "2",
  "3",
  "бпла",
  "шахед",
  "мопед",
]);

/** Слова фрази: як написано (для показу) і нормалізовані (для пошуку). */
function words(s: string): { orig: string[]; norm: string[] } {
  const orig = s
    .replace(/[^\p{L}\p{N}'’ʼ\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  return { orig, norm: orig.map(normName) };
}

/** Найдовша назва (до 3 слів) з початку фрази: «Великі Межиричі» перед «Великі». */
function leadingPlace(
  w: { orig: string[]; norm: string[] },
  gaz: Gazetteer,
): { places: GeoPlace[]; said: string; used: number } | null {
  for (let n = Math.min(3, w.norm.length); n >= 1; n--) {
    const key = w.norm.slice(0, n).join(" ");
    if (key.length < 3) continue;
    const places = gaz.find(key);
    if (places.length) return { places, said: w.orig.slice(0, n).join(" "), used: n };
  }
  return null;
}

interface Mention {
  kind: "position" | "course";
  places: GeoPlace[];
  said: string;
}

/** Що каже допис: позиції й курси з кандидатами-пунктами (ще без вибору). */
export function mentionsOf(text: string, gaz: Gazetteer): Mention[] {
  const out: Mention[] = [];
  for (const raw of text.split(/\n|•|;/)) {
    const line = raw.trim();
    if (!line) continue;
    const course = line.match(COURSE_CUE);
    if (course) {
      const p = leadingPlace(words(course[1]!), gaz);
      if (p) out.push({ kind: "course", places: p.places, said: p.said });
    }
    const pos = line.match(POSITION_CUE);
    if (pos) {
      const p = leadingPlace(words(pos[1]!), gaz);
      if (p) out.push({ kind: "position", places: p.places, said: p.said });
      continue;
    }
    if (course) continue;
    // Допис лише з назв: «Гоща», «Самостріли/Бокшин», «Мʼятин/Глинки».
    const parts = line.split("/").map((x) => {
      const w = words(x);
      const keep = w.norm.map((n) => !FILLER.has(n));
      return { orig: w.orig.filter((_, i) => keep[i]), norm: w.norm.filter((_, i) => keep[i]) };
    });
    if (parts.every((w) => w.norm.length > 0 && w.norm.length <= 3)) {
      const found = parts.map((w) => {
        const p = leadingPlace(w, gaz);
        return p && p.used === w.norm.length ? p : null;
      });
      if (found.every((f) => f !== null)) {
        for (const f of found) out.push({ kind: "position", places: f!.places, said: f!.said });
      }
    }
  }
  return out;
}

function nearestTo(places: GeoPlace[], anchors: { lat: number; lon: number }[]): GeoPlace | null {
  let best: GeoPlace | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const p of places) {
    for (const a of anchors) {
      const d = distanceKm(p, a);
      if (d < bestKm) {
        bestKm = d;
        best = p;
      }
    }
  }
  if (best && bestKm <= MAX_ANCHOR_KM) return best;
  // Без близької опори — лише однозначна назва.
  return places.length === 1 ? places[0]! : null;
}

/**
 * Точки з дописів каналів за останні `FIX_WINDOW_MS`, з вибраними пунктами.
 * Опори для вибору — поточні цілі й попередні точки того ж каналу.
 */
export function channelFixes(
  messages: readonly ChannelMessage[],
  gaz: Gazetteer,
  threats: readonly Threat[],
  now: number,
): ChannelFix[] {
  const fresh = messages
    .filter((m) => m.channel && m.at <= now && now - m.at <= FIX_WINDOW_MS)
    .sort((a, b) => a.at - b.at);
  const lastByChannel = new Map<string, ChannelFix>();
  const out: ChannelFix[] = [];
  for (const m of fresh) {
    const prevFix = lastByChannel.get(m.channel!);
    if (prevFix && isEndOfTarget(m.text)) {
      out.push({ ...prevFix, at: m.at, kind: "end", said: m.text.trim() });
      // Наступна ціль каналу може бути будь-де — стара точка вже не опора.
      lastByChannel.delete(m.channel!);
      continue;
    }
    const ms = mentionsOf(m.text, gaz);
    if (!ms.length) continue;
    const type = classifyThreatType(m.text);
    // «Самостріли/Бокшин» — дві назви одного місця: точка — між ними.
    const positions: { place: GeoPlace; said: string }[] = [];
    for (const x of ms) {
      const prev = lastByChannel.get(m.channel!);
      const anchors = [
        ...(prev && m.at - prev.at <= MAX_LINK_GAP_MS ? [prev.place] : []),
        ...positions.map((p) => p.place),
        ...threats,
      ];
      const place = nearestTo(x.places, anchors);
      if (!place) continue;
      if (x.kind === "position") positions.push({ place, said: x.said });
      else out.push({ channel: m.channel!, at: m.at, kind: "course", place, said: x.said, type });
    }
    if (positions.length) {
      const near = positions.filter((p) => distanceKm(p.place, positions[0]!.place) <= 25);
      const lat = near.reduce((s, p) => s + p.place.lat, 0) / near.length;
      const lon = near.reduce((s, p) => s + p.place.lon, 0) / near.length;
      const fix: ChannelFix = {
        channel: m.channel!,
        at: m.at,
        kind: "position",
        place: {
          name: near.map((p) => shownName(p, gaz)).join("/"),
          lat,
          lon,
          admin: near[0]!.place.admin,
        },
        said: near.map((p) => p.said).join("/"),
        type,
      };
      out.push(fix);
      lastByChannel.set(m.channel!, fix);
    }
  }
  return out;
}

/**
 * Назва для позначки. Як у дописі — коли це точна форма цього пункту в
 * довіднику, тобто вже називний відмінок: GeoNames місцями пише назви
 * криво («Мятин» без апострофа, «Дубровіца» замість «Дубровиця»), а канал —
 * так, як кажуть. Інакше — з довідника: «над Вільнянськом» → «Вільнянськ».
 */
function shownName(p: { place: GeoPlace; said: string }, gaz: Gazetteer): string {
  return gaz.named(normName(p.said)).includes(p.place) ? p.said : p.place.name;
}

export interface ChannelTrack {
  channel: string;
  fixes: ChannelFix[];
  /** Останній названий курс, якщо був після останньої позиції. */
  course: ChannelFix | null;
  type: ThreatType;
  /** Канал сказав «зникла» / «збито»: на карті трек уже не веде нічого. */
  ended: boolean;
}

/** Точки одного каналу, зшиті в треки за правдоподібністю польоту між ними. */
export function buildTracks(fixes: readonly ChannelFix[]): ChannelTrack[] {
  const tracks: ChannelTrack[] = [];
  const open = new Map<string, ChannelTrack>();
  for (const f of [...fixes].sort((a, b) => a.at - b.at)) {
    const t = open.get(f.channel);
    if (f.kind === "end") {
      if (t) t.ended = true;
      open.delete(f.channel);
      continue;
    }
    if (f.kind === "course") {
      if (t) t.course = f;
      continue;
    }
    const last = t?.fixes[t.fixes.length - 1];
    const ok =
      t &&
      last &&
      f.at - last.at <= MAX_LINK_GAP_MS &&
      distanceKm(last.place, f.place) / Math.max((f.at - last.at) / 3_600_000, 1 / 60) <=
        MAX_LINK_KMH;
    if (t && ok) {
      t.fixes.push(f);
      t.course = null;
      if (t.type === "unknown") t.type = f.type;
    } else {
      const nt: ChannelTrack = {
        channel: f.channel,
        fixes: [f],
        course: null,
        type: f.type,
        ended: false,
      };
      tracks.push(nt);
      open.set(f.channel, nt);
    }
  }
  return tracks;
}

/**
 * Трек з каналу → оновлення цілей.
 *
 *  - Є ціль Нептуна в `MATCH_TARGET_KM` від останньої точки, давніша за неї —
 *    позначка переїжджає в точку каналу, курс — із двох останніх точок (це
 *    спостережений рух, а не здогадка), трек — точки каналу.
 *  - Цілі поруч немає, а точок ≥ 2 — нова ціль із каналу (випадок #108: Нептун
 *    мовчав, канал вів ціль поіменно). Одна точка нової цілі не створює:
 *    одиночна згадка могла бути про будь-що.
 *  - Названий після позиції курс («Відвернув на Бугрин») — лише напрямок,
 *    позначений як припущений.
 */
export function applyChannelTracks(
  threats: readonly Threat[],
  tracks: readonly ChannelTrack[],
): Threat[] {
  const out = threats.map((t) => ({ ...t }));
  const DRONES = new Set<ThreatType>(["shahed", "reactive", "unknown", "recon"]);
  for (const tr of tracks) {
    if (tr.ended) continue;
    const last = tr.fixes[tr.fixes.length - 1]!;
    // Курс — від найближчої попередньої точки, що вже за ≥ 3 км: сусідні дописи
    // часто називають села за кілометр одне від одного («Мʼятин» → «Глинки»),
    // і курс між ними — шум, а не рух.
    const prev =
      [...tr.fixes.slice(0, -1)].reverse().find((f) => distanceKm(f.place, last.place) >= 3) ??
      null;
    const lastIso = new Date(last.at).toISOString();
    let heading: number | null = null;
    let observed = false;
    if (prev && distanceKm(prev.place, last.place) >= 3) {
      heading = bearingDeg(prev.place, last.place);
      observed = true;
    }
    if (tr.course && tr.course.at >= last.at) {
      heading = bearingDeg(last.place, tr.course.place);
      observed = false;
    }
    const trail = tr.fixes.map((f) => ({
      lat: f.place.lat,
      lon: f.place.lon,
      t: new Date(f.at).toISOString(),
    }));

    let best: Threat | null = null;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const t of out) {
      if (!DRONES.has(t.type ?? "unknown")) continue;
      const d = distanceKm(t, last.place);
      if (d < bestKm) {
        bestKm = d;
        best = t;
      }
    }
    const sinceMs = best ? Date.parse(best.since || best.lastSeen || "") : Number.NaN;
    if (best && bestKm <= MATCH_TARGET_KM) {
      if (Number.isFinite(sinceMs) && sinceMs > last.at) continue; // джерело свіжіше
      best.lat = last.place.lat;
      best.lon = last.place.lon;
      best.name = last.place.name;
      best.since = lastIso;
      best.lastSeen = lastIso;
      if (heading !== null) best.heading = heading;
      best.quality = {
        ...(best.quality ?? {
          uncertaintyKm: null,
          position: null,
          lifecycle: null,
          presumptiveCourse: true,
          speedKmh: null,
        }),
        uncertaintyKm: 5,
        position: "approx",
        presumptiveCourse: heading === null ? (best.quality?.presumptiveCourse ?? true) : !observed,
      };
      if (trail.length >= 2) best.trail = trail;
      best.sources = [...new Set([...(best.sources ?? []), best.source, tr.channel])];
      continue;
    }
    if (tr.fixes.length < 2) continue;
    out.push({
      id: `ch:${tr.channel}:${tr.fixes[0]!.at}`,
      name: last.place.name,
      lat: last.place.lat,
      lon: last.place.lon,
      source: tr.channel,
      sources: [tr.channel],
      count: 1,
      since: lastIso,
      expires: "",
      lastSeen: lastIso,
      // Тип — лише якщо канал його назвав; «невідомий» чесніший за вгаданий «шахед».
      type: tr.type,
      ...(heading !== null ? { heading } : {}),
      quality: {
        uncertaintyKm: 5,
        position: "approx",
        lifecycle: "tracking",
        presumptiveCourse: !observed,
        speedKmh: null,
      },
      trail,
    });
  }
  return out;
}
