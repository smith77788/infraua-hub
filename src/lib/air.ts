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
  /** Скільки окремих повідомлень злилось у цю позначку та з яких каналів. */
  reports?: number;
  sources?: string[];
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
 * Зливає повітряні цілі, що стоять поруч (різні OSINT-канали повідомляють ту
 * саму ціль/район у радіусі `radiusKm`), в одну позначку — щоб на карті не було
 * стосів дублікатів над одним містом. Жадібна кластеризація: найраніша ціль стає
 * ядром, решта в радіусі приєднуються з підрахунком звітів і джерел.
 */
export function fuseThreats(threats: Threat[], radiusKm = 6): Threat[] {
  const sorted = [...threats].sort((a, b) => (a.since || "").localeCompare(b.since || ""));
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
      if (cand && threatDistanceKm(core, cand) <= radiusKm) {
        used.add(j);
        members.push(cand);
      }
    }
    const sources = [...new Set(members.map((m) => m.source).filter(Boolean))];
    out.push({
      ...core,
      count: members.reduce((n, m) => n + (m.count || 1), 0),
      reports: members.length,
      sources,
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
