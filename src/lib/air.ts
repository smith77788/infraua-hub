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
}

export interface AlertZone {
  region: string;
  type: string;
  /** Зовнішні кільця у форматі Leaflet: [lat, lon][]. */
  polygons: [number, number][][];
}
