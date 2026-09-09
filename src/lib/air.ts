/**
 * Дані повітряної обстановки з відкритого джерела detoyshahed.in.ua:
 * — активні тривоги з реальними полігонами регіонів;
 * — активні інциденти (позначки повітряних цілей за даними OSINT-каналів).
 */

/** Перетворення Web Mercator (EPSG:3857, метри) → WGS84 [lat, lon]. */
export function mercToLatLon(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  let lat = (y / 20037508.34) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return [lat, lon];
}

export interface Threat {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** OSINT-канал-джерело повідомлення. */
  source: string;
  count: number;
  since: string;
  expires: string;
  /** OSM-ідентифікатор місця позначки — той самий пункт від різних каналів. */
  osmId?: number;
  /** Скільки окремих повідомлень злилось у цю позначку та з яких каналів. */
  reports?: number;
  sources?: string[];
  /** Час найсвіжішого повідомлення у злитій позначці (для індикації свіжості). */
  lastSeen?: string;
}

function threatDistanceKm(a: Threat, b: Threat): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Зливає повітряні цілі-дублікати в одну позначку. Дублі бувають двох видів:
 * різні OSINT-канали повідомляють (1) той самий пункт (однаковий `osmId`) або
 * (2) сусідні точки в радіусі `radiusKm`. І те, й те стягується в одну позначку,
 * щоб над містом не було стосу міток.
 *
 * Ядром стає найсвіжіше повідомлення (не найраніше): на карті першою має бути
 * актуальна позиція, а `lastSeen` несе час останнього сигналу для індикації
 * свіжості. Звіти й канали агрегуються.
 */
export function fuseThreats(threats: Threat[], radiusKm = 8): Threat[] {
  // Свіжіші — раніше: ядром кластера стає останній за часом сигнал.
  const sorted = [...threats].sort((a, b) => (b.since || "").localeCompare(a.since || ""));
  const used = new Set<number>();
  const out: Threat[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const core = sorted[i];
    if (!core) continue;
    const members: Threat[] = [core];
    used.add(i);
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const cand = sorted[j];
      if (!cand) continue;
      // Той самий пункт (osmId) зливаємо завжди; інакше — за близькістю.
      const samePlace = core.osmId != null && cand.osmId != null && core.osmId === cand.osmId;
      if (samePlace || threatDistanceKm(core, cand) <= radiusKm) {
        used.add(j);
        members.push(cand);
      }
    }
    const sources = [...new Set(members.map((m) => m.source).filter(Boolean))];
    let lastSeen = core.since;
    for (const m of members) if ((m.since || "") > lastSeen) lastSeen = m.since;
    out.push({
      ...core,
      count: members.reduce((n, m) => n + (m.count || 1), 0),
      reports: members.length,
      sources,
      lastSeen,
    });
  }
  return out;
}

export interface AlertZone {
  region: string;
  type: string;
  /** Зовнішні кільця у форматі Leaflet: [lat, lon][]. */
  polygons: [number, number][][];
}
