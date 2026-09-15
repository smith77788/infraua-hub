/**
 * Де сховатися: укриття, метро й підземні споруди поруч із точкою.
 *
 * ## Чому цього довго не було і чому воно ледь не вийшло шкідливим
 *
 * Перша спроба взяти укриття з OSM за очевидним тегом `amenity=shelter`
 * провалилася, і добре, що провалилася на перевірці, а не в людей. По Україні
 * цей тег означає зовсім інше: заміряно навколо Києва — з 400 обʼєктів 91
 * альтанка, 65 накриття для пікніка, 41 зупинка транспорту. Ще гірше з
 * `building=bunker`: по країні їх 580, і це ДОТи Другої світової, здебільшого
 * руїни — «Лінія Арпада», «ДОТ №35 СОР». Відправити людину під час нальоту в
 * альтанку або в зруйнований ДОТ — гірше, ніж не відправити нікуди.
 *
 * «Пункти незламності» теж не проходять за назвою: з 108 збігів по країні сто
 * не мають узагалі жодного змістовного тегу, а серед них трапляється «площа
 * Незламності» — тобто пошук за назвою кладе на карту площі й вулиці.
 *
 * Тому сюди потрапляє лише те, що розмічене однозначно, і кожен вид названо
 * своїм іменем — бо це різні за захистом речі, і плутати їх не можна.
 *
 * ## Межа, яку треба назвати вголос
 *
 * Це НЕ державний реєстр захисних споруд. В Україні укриття за законом є
 * майже в кожній школі, лікарні й закладі, але в OSM їх немає — тож ми не
 * знаємо про них і не вдаємо, що знаємо. Показане тут — підмножина, і
 * інтерфейс мусить казати це прямо: «поруч може бути ближче укриття, якого
 * немає на карті».
 */

/** Вид укриття. Порядок — за наданим захистом, від найкращого. */
export type ShelterKind = "shelter" | "metro" | "metro_entrance" | "underground" | "invincibility";

export interface Shelter {
  id: string;
  kind: ShelterKind;
  name: string;
  lat: number;
  lon: number;
  /** Скільки людей вміщує, якщо в даних це є. */
  capacity?: number;
  /** Доступ за даними OSM: yes / permissive / private / no. */
  access?: string;
}

export const KIND_LABEL: Record<ShelterKind, string> = {
  shelter: "Укриття",
  metro: "Станція метро",
  metro_entrance: "Вхід у метро",
  underground: "Підземний паркінг",
  invincibility: "Пункт незламності",
};

/**
 * Чесний підпис того, ЩО це насправді дає.
 *
 * Підземний паркінг — не обладнане укриття, і назвати його укриттям означало б
 * пообіцяти захист, якого ніхто не гарантував. Але він підземний, люди ним
 * користуються, і сховати цей факт — теж рішення за людину.
 */
export const KIND_NOTE: Record<ShelterKind, string> = {
  shelter: "обладнане укриття",
  metro: "глибока станція — класичне укриття",
  metro_entrance: "вхід на станцію",
  underground: "підземне, але не обладнане укриття",
  // Найважливіший підпис у цьому переліку. Пункт незламності — це тепло,
  // світло і звʼязок під час блекауту, а НЕ захист від удару. Людина, яка
  // побіжить туди від «шахеда», побіжить не туди.
  invincibility: "тепло і звʼязок під час блекауту, не захист від удару",
};

/** Емодзі для бота: рядок має читатися оком, а не розбиратися. */
export const KIND_EMOJI: Record<ShelterKind, string> = {
  shelter: "🛡",
  metro: "🚇",
  metro_entrance: "🚇",
  underground: "🅿️",
  invincibility: "🔌",
};

const KIND_RANK: Record<ShelterKind, number> = {
  shelter: 0,
  metro: 1,
  metro_entrance: 2,
  underground: 3,
  // Останній свідомо: від удару він не захищає, тож у списку «куди бігти»
  // не має витісняти нічого підземного.
  invincibility: 4,
};

/**
 * Запит до Overpass по прямокутнику.
 *
 * Свідомо НЕ містить `amenity=shelter` без уточнення й `building=bunker` — див.
 * пояснення вгорі файлу. Кожен рядок тут — те, що означає саме те, що каже.
 */
export function shelterQuery(bbox: {
  south: number;
  west: number;
  north: number;
  east: number;
}): string {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return [
    "[out:json][timeout:60];",
    "(",
    `nwr["shelter_type"~"^(bomb_shelter|bomb|air_raid|civil_defense)$"](${b});`,
    `nwr["emergency"="shelter"](${b});`,
    `nwr["station"="subway"](${b});`,
    `node["railway"="subway_entrance"](${b});`,
    `nwr["amenity"="parking"]["parking"="underground"](${b});`,
    /*
     * Пункти незламності шукаються за назвою, і саме за ПОВНОЮ фразою
     * «пункт незламності», а не за словом «незламност». Заміряно по країні:
     * широкий збіг дає 108 обʼєктів, з яких сто без жодного змістовного тегу,
     * і серед них «площа Незламності» — тобто площі й вулиці, названі на
     * честь, а не пункти. Точна фраза лишає 8 на всю країну — це мало, але це
     * справжнє, а класти на карту площу під виглядом пункту не можна.
     */
    `nwr["name"~"[Пп]ункт.?[Нн]езламност",i](${b});`,
    ");",
    "out center 800;",
  ].join("");
}

interface RawElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Вид укриття з тегів. `null` — це не укриття, і мовчки в список воно не йде.
 *
 * Перевірки йдуть від найспецифічнішої: станція метро теж може мати
 * `shelter_type`, і тоді вона має лишитись укриттям, а не входом.
 */
export function classifyShelter(tags: Record<string, string>): ShelterKind | null {
  const st = tags["shelter_type"];
  if (st && /^(bomb_shelter|bomb|air_raid|civil_defense)$/.test(st)) return "shelter";
  if (tags["emergency"] === "shelter") return "shelter";
  if (tags["station"] === "subway") return "metro";
  if (tags["railway"] === "subway_entrance") return "metro_entrance";
  if (tags["amenity"] === "parking" && tags["parking"] === "underground") return "underground";
  // Тільки повна фраза: «площа Незламності» — це площа, а не пункт.
  const name = tags["name:uk"] ?? tags["name"] ?? "";
  if (/[Пп]ункт.?[Нн]езламност/.test(name)) return "invincibility";
  return null;
}

function parseCapacity(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function toShelter(el: RawElement): Shelter | null {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const tags = el.tags ?? {};
  const kind = classifyShelter(tags);
  if (!kind) return null;
  // Закрите для входу укриття — не укриття для людини, яка біжить.
  if (tags["access"] === "no" || tags["access"] === "private") return null;

  const capacity = parseCapacity(tags["capacity"]);
  const access = tags["access"];
  return {
    id: `${el.type}/${el.id}`,
    kind,
    name: tags["name:uk"] ?? tags["name"] ?? KIND_LABEL[kind],
    lat,
    lon,
    ...(capacity !== undefined ? { capacity } : {}),
    ...(access ? { access } : {}),
  };
}

/** Відстань між точками, км (та сама формула, що в решті проєкту). */
function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface NearbyShelter extends Shelter {
  distanceKm: number;
  /** Скільки йти пішки, хв — за 5 км/год. */
  walkMin: number;
}

/**
 * Найближчі укриття до точки.
 *
 * Сортування не просто за відстанню: обладнане укриття за 700 метрів корисніше
 * за вхід у метро за 600, бо різниця в захисті більша за різницю в дорозі. Тому
 * спершу вид, потім відстань — але лише в межах одного «кроку» дальності, щоб
 * укриття за пʼять кілометрів не витіснило метро за двісті метрів.
 */
export function nearestShelters(
  point: { lat: number; lon: number },
  shelters: readonly Shelter[],
  opts: { limit?: number; maxKm?: number } = {},
): NearbyShelter[] {
  const limit = opts.limit ?? 5;
  const maxKm = opts.maxKm ?? 5;

  const withDistance = shelters
    .map((s) => {
      const d = distanceKm(point, s);
      return {
        ...s,
        distanceKm: Math.round(d * 100) / 100,
        walkMin: Math.max(1, Math.round((d / 5) * 60)),
      };
    })
    .filter((s) => s.distanceKm <= maxKm);

  withDistance.sort((a, b) => {
    // Рівні дальності по 500 м: усередині кроку виграє кращий захист.
    const stepA = Math.floor(a.distanceKm / 0.5);
    const stepB = Math.floor(b.distanceKm / 0.5);
    if (stepA !== stepB) return stepA - stepB;
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return a.distanceKm - b.distanceKm;
  });

  /*
   * Вхід у метро й сама станція — це те саме місце, і показувати обидва
   * означало б витратити рядок списку на повтор. Лишаємо найближчий із пари.
   */
  const out: NearbyShelter[] = [];
  for (const s of withDistance) {
    const duplicate = out.some(
      (o) =>
        (o.kind === "metro" || o.kind === "metro_entrance") &&
        (s.kind === "metro" || s.kind === "metro_entrance") &&
        distanceKm(o, s) < 0.35,
    );
    if (duplicate) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Застереження про покриття — обовʼязкове скрізь, де показано цей список.
 *
 * Не ввічлива формальність: людина, яка бачить на карті три точки, робить
 * висновок, що інших немає. Насправді укриття за законом є майже в кожній
 * школі й лікарні, просто в наших даних їх немає.
 */
export const COVERAGE_CAVEAT =
  "Це не державний реєстр: показано лише те, що розмічено на відкритій карті. " +
  "Поруч може бути ближче укриття — у школі, лікарні чи вашому будинку.";
