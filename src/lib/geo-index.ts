/**
 * Просторовий індекс: хто взагалі може бути під загрозою.
 *
 * ## Стеля, яку це прибирає
 *
 * Обхід підписників був влаштований так: для КОЖНОГО підписника порахувати
 * відстань до КОЖНОЇ цілі. Це O(підписники × цілі). На тисячі підписників воно
 * непомітне, на мільйоні — 100 мільйонів обчислень щопівтори хвилини, і обхід
 * перестає встигати за власним тактом ще до того, як упреться в ліміти
 * Telegram.
 *
 * Гірше те, що це витрачається майже повністю намарно: під час нальоту цілі
 * стоять над кількома областями, а решта країни не має до них жодного
 * стосунку. Рахувати для киянина відстань до шахеда над Одещиною — це робота,
 * відповідь на яку відома наперед.
 *
 * ## Що робиться натомість
 *
 * Питання перевертається. Замість «для кожного підписника — які цілі поруч»
 * ставимо «для кожної цілі — хто поруч». Цілей десятки, підписників мільйони,
 * і саме тому напрямок має значення.
 *
 * Підписники розкладаються по сітці комірок. Ціль дивиться лише в ті комірки,
 * що перетинають коло її впливу. Вартість стає O(цілі × сусіди), і вона не
 * росте від тих, кого наліт не стосується.
 *
 * ## Чому надлишок безпечний, а нестача — ні
 *
 * Сітка навмисно віддає ЗАЙВИХ кандидатів: межі комірок не збігаються з колом,
 * а довгота стискається з широтою по-різному. Зайвий кандидат коштує одного
 * точного обчислення відстані, яке його й відкине. Пропущений кандидат коштує
 * людині сповіщення, якого вона не отримає. Тому всюди, де є вибір, береться
 * ширша оцінка — і тест звіряє результат із повним перебором до збігу.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Градус широти в кілометрах — стала з достатньою для нас точністю. */
const KM_PER_DEG_LAT = 111.32;

/**
 * Найменший косинус широти в межах України (≈52.4° на півночі) з запасом.
 *
 * Потрібен саме найменший: чим менший косинус, тим ШИРШИЙ у градусах виходить
 * той самий кілометровий радіус, тобто тим більше комірок ми переглянемо.
 * Помилитись у цей бік — переглянути зайве; у протилежний — пропустити людину.
 */
const MIN_COS_LAT = 0.58;

export interface GeoIndex<T> {
  cellKm: number;
  cells: Map<string, T[]>;
  size: number;
}

function cellKey(latBand: number, lonBand: number): string {
  return `${latBand}:${lonBand}`;
}

function bands(point: GeoPoint, cellKm: number): { lat: number; lon: number } {
  const dLat = cellKm / KM_PER_DEG_LAT;
  const dLon = cellKm / (KM_PER_DEG_LAT * MIN_COS_LAT);
  return { lat: Math.floor(point.lat / dLat), lon: Math.floor(point.lon / dLon) };
}

/**
 * Розкладає точки по сітці.
 *
 * `cellKm` ≈ типовому радіусу запиту: надто дрібні комірки означають багато
 * ключів на один запит, надто великі — багато зайвих кандидатів у кожній.
 */
export function buildGeoIndex<T extends GeoPoint>(items: readonly T[], cellKm = 50): GeoIndex<T> {
  const cells = new Map<string, T[]>();
  for (const item of items) {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    const b = bands(item, cellKm);
    const key = cellKey(b.lat, b.lon);
    const bucket = cells.get(key);
    if (bucket) bucket.push(item);
    else cells.set(key, [item]);
  }
  return { cellKm, cells, size: items.length };
}

/**
 * Кандидати в межах `radiusKm` від точки — з надлишком, без пропусків.
 *
 * Повертає саме КАНДИДАТІВ, а не відповідь: точну відстань рахує викликач, бо
 * лише він знає, що з нею робити (радіус у кожного підписника свій).
 */
export function queryGeoIndex<T extends GeoPoint>(
  index: GeoIndex<T>,
  point: GeoPoint,
  radiusKm: number,
): T[] {
  const { cellKm } = index;
  const dLat = cellKm / KM_PER_DEG_LAT;
  const dLon = cellKm / (KM_PER_DEG_LAT * MIN_COS_LAT);
  // Скільки комірок у кожен бік накриває радіус. `ceil` і ще одна комірка
  // згори: точка може стояти біля самого краю своєї комірки.
  const spanLat = Math.ceil(radiusKm / KM_PER_DEG_LAT / dLat) + 1;
  const spanLon = Math.ceil(radiusKm / (KM_PER_DEG_LAT * MIN_COS_LAT) / dLon) + 1;

  const origin = bands(point, cellKm);
  const out: T[] = [];
  for (let i = -spanLat; i <= spanLat; i++) {
    for (let j = -spanLon; j <= spanLon; j++) {
      const bucket = index.cells.get(cellKey(origin.lat + i, origin.lon + j));
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

/**
 * Об'єднані кандидати для набору цілей.
 *
 * Дедуп обов'язковий: під час нальоту цілі стоять купно, їхні кола
 * перетинаються, і без нього той самий підписник обраховувався б стільки
 * разів, скільки цілей його накрили, — тобто рівно там, де навантаження й так
 * найбільше.
 */
export function candidatesFor<T extends GeoPoint>(
  index: GeoIndex<T>,
  sources: readonly GeoPoint[],
  radiusKm: number,
  keyOf: (item: T) => string | number,
): T[] {
  const seen = new Set<string | number>();
  const out: T[] = [];
  for (const source of sources) {
    for (const item of queryGeoIndex(index, source, radiusKm)) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
