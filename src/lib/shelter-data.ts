/**
 * Укриття з локального набору — без мережі й без очікування.
 *
 * ## Чому не запит під час роботи
 *
 * Заміряно на живому Overpass той самий запит по місту: то 10 секунд, то 45,
 * то не віддає зовсім (Київ і Харків стабільно впирались у стелю, Львів
 * пройшов за 44 с). Залежність, яка гальмує саме тоді, коли на неї спирається
 * кнопка «куди сховатися», для аварійної функції не годиться: сплеск
 * навантаження на публічний Overpass і сплеск потреби в укриттях трапляються
 * з тих самих причин і в той самий час.
 *
 * Дані статичні — станції метро й обладнані сховища не зʼявляються щогодини, —
 * тож вони збираються заздалегідь (`scripts/build-shelters.mjs`), лежать у
 * репозиторії й віддаються миттєво. Мережа лишається джерелом ОНОВЛЕННЯ
 * набору, а не джерелом відповіді людині.
 *
 * ## Формат
 *
 * Поля однолітерні навмисно: набір їде до кожного, хто відкриє консоль, і
 * різниця між `"kind"` і `"k"` на кілька тисяч записів — це десятки кілобайт.
 */

import raw from "../data/shelters.json";
import type { Shelter, ShelterKind } from "./shelters";

interface Packed {
  i: string;
  k: string;
  a: number;
  o: number;
  n?: string;
  c?: number;
}

const KINDS: ReadonlySet<string> = new Set<ShelterKind>([
  "shelter",
  "metro",
  "metro_entrance",
  "underground",
  "invincibility",
]);

const LABEL_FALLBACK: Record<ShelterKind, string> = {
  shelter: "Укриття",
  metro: "Станція метро",
  metro_entrance: "Вхід у метро",
  underground: "Підземний паркінг",
  invincibility: "Пункт незламності",
};

function unpack(p: Packed): Shelter | null {
  if (!KINDS.has(p.k)) return null;
  const kind = p.k as ShelterKind;
  return {
    id: p.i,
    kind,
    name: p.n ?? LABEL_FALLBACK[kind],
    lat: p.a,
    lon: p.o,
    ...(p.c !== undefined ? { capacity: p.c } : {}),
  };
}

/**
 * Увесь набір, розпакований один раз.
 *
 * Модульний рівень, а не функція з кешем: набір незмінний, розпакування чисте,
 * і другого варіанта правди тут бути не може.
 */
export const ALL_SHELTERS: readonly Shelter[] = (raw as Packed[])
  .map(unpack)
  .filter((s): s is Shelter => s !== null);

/**
 * Укриття в прямокутнику.
 *
 * Лінійний перебір: набір — кілька тисяч точок, і просте порівняння координат
 * на ньому займає частки мілісекунди. Просторовий індекс тут був би складністю
 * без виграшу, і його довелося б тримати узгодженим із набором.
 */
export function sheltersInBox(box: {
  south: number;
  west: number;
  north: number;
  east: number;
}): Shelter[] {
  const out: Shelter[] = [];
  for (const s of ALL_SHELTERS) {
    if (s.lat >= box.south && s.lat <= box.north && s.lon >= box.west && s.lon <= box.east) {
      out.push(s);
    }
  }
  return out;
}
