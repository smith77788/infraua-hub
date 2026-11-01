/**
 * Цілі майже в одній точці — окремими значками поруч, а не одна під одною
 * (опитувальник 01.11: «окремі іконки поруч»). Позиція на карті не
 * змінюється: зсувається лише малюнок значка, по колу радіусом `SPREAD_PX`.
 */
const SPREAD_PX = 16;
export function spreadOffsets(
  points: readonly { id: string; lat: number; lon: number }[],
): Map<string, [number, number]> {
  const groups = new Map<string, string[]>();
  for (const p of points) {
    // ~1 км: ближче — на екрані це одна точка за будь-якого розумного масштабу.
    const key = `${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`;
    const list = groups.get(key);
    if (list) list.push(p.id);
    else groups.set(key, [p.id]);
  }
  const out = new Map<string, [number, number]>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    [...ids].sort().forEach((id, i) => {
      const a = (2 * Math.PI * i) / ids.length - Math.PI / 2;
      out.set(id, [Math.round(SPREAD_PX * Math.cos(a)), Math.round(SPREAD_PX * Math.sin(a))]);
    });
  }
  return out;
}
