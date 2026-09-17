import { classifyThreatType, type Threat, type ThreatType } from "./air";
import { readQuality } from "./threat-quality";
import { UA_BBOX } from "./infra-types";

/**
 * Спільний перекладач цілей Нептуна → наша модель.
 *
 * REST-фетч і WebSocket-міст читають ОДНЕ й те саме джерело (neptun.in.ua) з
 * ідентичною формою запису, тож і зіставлення має бути одне. Якби кожен шлях
 * мапив по-своєму, «наживо» й «з опитування» давали б дві різні правди про ту
 * саму ціль. Тому вся логіка тут, а обидва споживачі лише її викликають.
 */

export interface NeptunThreat {
  id: string;
  type?: string;
  title?: string;
  region?: string;
  district?: string;
  locality?: string;
  lat?: number;
  lon?: number;
  heading?: number | null;
  confidenceLevel?: string;
  sourceCount?: number;
  count?: number;
  updatedAt?: string;
  confirmedAt?: string;
  explanationShort?: string;
  status?: string;
  /* Заяви джерела про власну точність — розбираються в readQuality. */
  uncertaintyKm?: unknown;
  positionQuality?: unknown;
  lifecycle?: unknown;
  presumptiveCourse?: unknown;
  velocity?: unknown;
  sea?: unknown;
  trail?: unknown;
}

/** Тип цілі neptun → наш ThreatType. Спираємось на текст (title+пояснення). */
export function mapNeptunType(type: string | undefined, text: string): ThreatType {
  const byText = classifyThreatType(text);
  if (byText !== "unknown") return byText;
  const t = (type ?? "").toLowerCase();
  if (/ballist/.test(t)) return "ballistic";
  if (/cruise|krylat/.test(t)) return "cruise";
  if (/missile|rocket|raket/.test(t)) return "missile";
  if (/kab/.test(t)) return "kab";
  if (/recon|rozvid/.test(t)) return "recon";
  if (/aircraft|jet|avia/.test(t)) return "aircraft";
  if (/fpv|uav|drone|bpla|shahed/.test(t)) return "shahed";
  return "unknown";
}

/**
 * Трек із джерела — лише коректні точки.
 *
 * Джерело віддає його не завжди й не для всіх цілей, тож усе, що не є парою
 * скінченних координат із часом, відкидається мовчки: половина треку гірша за
 * його відсутність лише тоді, коли з неї малюють суцільну лінію, а тут вона до
 * лінії просто не доходить.
 */
export function readTrail(raw: unknown): { lat: number; lon: number; t: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { lat: number; lon: number; t: string }[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as { lat?: unknown; lon?: unknown; t?: unknown };
    if (
      typeof o.lat === "number" &&
      Number.isFinite(o.lat) &&
      typeof o.lon === "number" &&
      Number.isFinite(o.lon) &&
      typeof o.t === "string" &&
      o.t
    ) {
      out.push({ lat: o.lat, lon: o.lon, t: o.t });
    }
  }
  return out.length >= 2 ? out : null;
}

/**
 * Одна ціль Нептуна → наша `Threat`, або `null`, якщо її не можна показати.
 *
 * `Number.isFinite`, а не `typeof === "number"`: typeof NaN — це «number», а
 * всі порівняння NaN із межами bbox хибні, тож запис із NaN проходив би повз
 * обидві перевірки й потрапляв у систему. На карті його намалювати неможливо,
 * у лічильнику він є — і число над картою перестає збігатися з тим, що під нею.
 * Неактивні цілі та все поза межами України так само відкидаються тут, щоб
 * WebSocket-міст і REST-фетч фільтрували однаково.
 */
export function mapNeptunThreat(t: NeptunThreat): Threat | null {
  if (typeof t.lat !== "number" || !Number.isFinite(t.lat)) return null;
  if (typeof t.lon !== "number" || !Number.isFinite(t.lon)) return null;
  if (t.status && t.status !== "active") return null;
  if (
    t.lat < UA_BBOX.south ||
    t.lat > UA_BBOX.north ||
    t.lon < UA_BBOX.west ||
    t.lon > UA_BBOX.east
  )
    return null;
  const text = `${t.title ?? ""} ${t.explanationShort ?? ""}`;
  const trail = readTrail(t.trail);
  return {
    id: t.id,
    name: t.locality || t.district || t.region || t.title || "Ціль",
    lat: t.lat,
    lon: t.lon,
    source: "neptun.in.ua",
    type: mapNeptunType(t.type, text),
    count: t.count ?? 1,
    since: t.confirmedAt ?? t.updatedAt ?? "",
    expires: "",
    reports: t.sourceCount ?? 1,
    lastSeen: t.updatedAt ?? t.confirmedAt ?? "",
    ...(typeof t.heading === "number" ? { heading: t.heading } : {}),
    ...(t.confidenceLevel ? { confidence: t.confidenceLevel } : {}),
    // Те, що джерело каже про власну точність. Без цього позначка ±45 км
    // малювалась крапкою, а припущений курс — як спостережений.
    quality: readQuality(t),
    ...(trail ? { trail } : {}),
    ...(t.sea === true ? { sea: true } : {}),
    ...(t.region ? { region: t.region } : {}),
  };
}
