/**
 * Прогресивне завантаження по сітці тайлів.
 *
 * Спільний примітив, а не повторення. Так уже завантажуються лінії
 * електропередач: країна ділиться на тайли, за один виклик догружається
 * кілька, клієнт накопичує покриття сам і повідомляє серверові, що вже має.
 * Другому джерелу (підстанції без загальної стелі) потрібна рівно та сама
 * механіка, тож вона винесена сюди — разом із тим, що в ній легко зробити
 * неправильно.
 *
 * Накопичення саме на клієнті — не деталь смаку. Збірка йде під Cloudflare
 * Workers, де модульний стан живе в межах ізоляту: сервер не може нічого
 * накопичувати між запитами, бо наступний запит може потрапити в інший
 * ізолят.
 */

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Tile {
  south: number;
  west: number;
}

/** Ключ тайла — рядок, бо він їздить у запиті й лягає в Map. */
export function tileKey(tile: Tile): string {
  return `${tile.south}:${tile.west}`;
}

/**
 * Сітка тайлів, що покриває bbox.
 *
 * Південно-західний кут округлюється вниз до цілого градуса, тож сітка
 * стабільна між викликами: інакше ключі тайлів «попливли» б і клієнт
 * перезавантажував би те саме під іншими іменами.
 */
export function tileGrid(bbox: BBox, degrees: number): Tile[] {
  if (!(degrees > 0)) throw new Error("degrees must be positive");
  const tiles: Tile[] = [];
  for (let lat = Math.floor(bbox.south); lat < bbox.north; lat += degrees) {
    for (let lon = Math.floor(bbox.west); lon < bbox.east; lon += degrees) {
      tiles.push({ south: lat, west: lon });
    }
  }
  return tiles;
}

/** Межі одного тайла — те, що піде в запит до джерела. */
export function tileBBox(tile: Tile, degrees: number): BBox {
  return {
    south: tile.south,
    west: tile.west,
    north: tile.south + degrees,
    east: tile.west + degrees,
  };
}

/**
 * Наступні тайли до завантаження: ті, яких у клієнта ще немає, не більше
 * `limit` за раз.
 *
 * Обмеження існує, щоб один виклик не впирався в таймаут: джерело відповідає
 * секунди, і десяток тайлів поспіль не встигне.
 */
export function pendingTiles(grid: Tile[], have: Iterable<string>, limit: number): Tile[] {
  const held = new Set(have);
  const out: Tile[] = [];
  for (const tile of grid) {
    if (held.has(tileKey(tile))) continue;
    out.push(tile);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Додає щойно отримані тайли до накопичених.
 *
 * Повертає той самий обʼєкт, якщо нічого нового не додалося: інакше кожне
 * опитування створювало б нову Map, і React перераховував би весь граф на
 * порожньому місці. Вже наявний тайл не перезаписується — покриття лише
 * зростає, і повторна відповідь не може його зіпсувати.
 */
export function mergeTiles<T>(
  accumulated: Map<string, T>,
  incoming: { key: string; value: T }[],
): Map<string, T> {
  let changed = false;
  const next = new Map(accumulated);
  for (const tile of incoming) {
    if (next.has(tile.key)) continue;
    next.set(tile.key, tile.value);
    changed = true;
  }
  return changed ? next : accumulated;
}

/** Скільки покрито і чи є сенс питати далі. */
export function coverage(accumulated: ReadonlyMap<string, unknown>, total: number) {
  const loaded = Math.min(accumulated.size, total);
  return { loaded, total, complete: loaded >= total, share: total > 0 ? loaded / total : 1 };
}
