/**
 * Безпечний бік до укриття.
 *
 * Перелік найближчих укриттів відповідає на «куди», але не на «в який бік
 * бігти, коли ціль уже підходить». Різниця не теоретична: якщо загроза йде з
 * півдня, а найближче укриття — теж на південь, людина під тривогою побіжить
 * НАЗУСТРІЧ їй. Кілька сотень метрів у бік цілі — це не дрібниця в останню
 * хвилину.
 *
 * Тому, коли відомий азимут підльоту, укриття отримують мʼяку позначку: те, що
 * НЕ в бік загрози, підіймається вище. Це нюанс, а не заборона — укриття поруч
 * важливіше за ідеальний бік, і жодне не викидається з переліку. Ми лише не
 * мовчимо про те, що видно.
 *
 * Чиста геометрія: азимут і кут беруться з threat-eta, свого дублювання немає.
 */

import { bearingDeg, angularDiff } from "./threat-eta";

export interface SafeSidePoint {
  lat: number;
  lon: number;
}

/** Наскільки укриття «в бік загрози» чи «геть від неї». */
export type SafeSide = "away" | "flank" | "toward";

export interface SafeSideMark<T> {
  item: T;
  /** Азимут із точки НА укриття. */
  bearing: number;
  /** Відхилення напрямку до укриття від напрямку, ЗВІДКИ йде загроза. */
  offFromThreatDeg: number;
  side: SafeSide;
  /** Готова примітка людською мовою або `null`, коли боку не рахували. */
  note: string | null;
}

const SIDE_NOTE: Record<SafeSide, string> = {
  away: "у протилежний від загрози бік",
  flank: "збоку від напрямку загрози",
  toward: "у бік загрози — бігти пригинаючись, краще обрати інше поруч",
};

/**
 * Позначає й переупорядковує укриття за безпекою боку.
 *
 * `threatFromBearing` — азимут (0=Пн), З ЯКОГО боку підходить загроза (тобто
 * азимут із точки на позицію цілі). `null`/`undefined` — напрямок невідомий:
 * тоді нічого не вигадуємо, лишаємо порядок як є й боку не рахуємо.
 *
 * Сортування СТАБІЛЬНЕ й мʼяке: спершу за близькістю боку до безпечного, але
 * вхідний порядок (як правило, за відстанню) — визначальний тайбрейкер, тож
 * далеке «ідеальне» укриття не обжене близьке прийнятне.
 */
export function rankBySafeSide<T extends SafeSidePoint>(
  point: SafeSidePoint,
  shelters: readonly T[],
  threatFromBearing: number | null | undefined,
  opts: { flankDeg?: number; towardDeg?: number } = {},
): SafeSideMark<T>[] {
  const flankDeg = opts.flankDeg ?? 60;
  const towardDeg = opts.towardDeg ?? 60;

  const marked: (SafeSideMark<T> & { order: number })[] = shelters.map((item, order) => {
    const bearing = Math.round(bearingDeg(point, item));
    if (threatFromBearing == null) {
      return {
        item,
        bearing,
        offFromThreatDeg: 0,
        side: "flank" as SafeSide,
        note: null,
        order,
      };
    }
    // Наскільки напрямок до укриття збігається з напрямком НА загрозу.
    const off = angularDiff(bearing, threatFromBearing);
    // Кут до ПРОТИЛЕЖНОГО від загрози боку: 0 означає ідеально геть від неї.
    const offAway = angularDiff(bearing, (threatFromBearing + 180) % 360);
    const side: SafeSide = off <= towardDeg ? "toward" : offAway <= flankDeg ? "away" : "flank";
    return {
      item,
      bearing,
      offFromThreatDeg: Math.round(off),
      side,
      note: SIDE_NOTE[side],
      order,
    };
  });

  const rank: Record<SafeSide, number> = { away: 0, flank: 1, toward: 2 };
  if (threatFromBearing != null) {
    marked.sort((a, b) => rank[a.side] - rank[b.side] || a.order - b.order);
  }
  return marked.map(({ order: _order, ...m }) => m);
}
