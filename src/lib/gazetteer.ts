/**
 * Довідник населених пунктів України — щоб «Гоща», «Бокшин», «Великі
 * Межиричі» з дописів каналів ставали точками на карті.
 *
 * Дані — `assets/geo/ua-places.tsv` (GeoNames, CC BY 4.0, див. README поруч):
 * 33 527 пунктів, кириличні назви (українські й російські форми), координати
 * до ~100 м. Великих міст проєкту (`ua-cities`) тут замало: канали ведуть ціль
 * по СЕЛАХ.
 *
 * Пошук розуміє відмінки, бо канали пишуть «повз Гощу», «з Львова», «південніше
 * Чемерівців». Неоднозначність не вирішує: «Федорівок» в Україні 63, і вибрати
 * потрібну може лише той, хто знає, де ціль (`channel-track`).
 */

export interface GeoPlace {
  name: string;
  lat: number;
  lon: number;
  /** Код області GeoNames (admin1). */
  admin: string;
}

/**
 * Нормалізація — та сама, що будувала ключі довідника: і/и/ы/ї → и, є/э → е,
 * ґ → г, й → и, ё → е, без апострофів і наголосів, дефіс → пробіл. Українська
 * й російська форми однієї назви збігаються («Межиричі» = «Межирічі»).
 */
export function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-̅̇̉-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/ґ/g, "г")
    .replace(/й/g, "и")
    .replace(/[’'ʼ`´]/g, "")
    .replace(/[іиыї]/g, "и")
    .replace(/[єэ]/g, "е")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ENDINGS = [
  "ами",
  "ями",
  "ах",
  "ях",
  "ам",
  "ям",
  "ив",
  "ов",
  "ев",
  "ом",
  "ою",
  "ею",
  "еи",
  "у",
  "ю",
  "а",
  "я",
  "и",
  "е",
  "о",
  "ь",
];

/**
 * Основа слова для пошуку у відмінках. Одна основа на слово: відрізаємо
 * найдовше відоме закінчення, але лишаємо щонайменше 3 літери.
 */
export function stemOf(word: string): string {
  for (const e of ENDINGS) {
    if (word.endsWith(e) && word.length - e.length >= 3) return word.slice(0, -e.length);
  }
  return word;
}

/** Основи назви: звичайна + чергування і/о («Львів» → «Львова», «Харків» → «Харкова»). */
function stemsOfName(key: string): string[] {
  const words = key.split(" ");
  const last = words[words.length - 1]!;
  const base = [...words.slice(0, -1), stemOf(last)].join(" ");
  const out = [base];
  if (/ив$/.test(last)) out.push([...words.slice(0, -1), last.slice(0, -2) + "ов"].join(" "));
  return out;
}

export class Gazetteer {
  private exact = new Map<string, GeoPlace[]>();
  private stems = new Map<string, GeoPlace[]>();
  private all: GeoPlace[] = [];
  readonly size: number;

  constructor(tsv: string) {
    let n = 0;
    for (const line of tsv.split("\n")) {
      if (!line) continue;
      const [name, keys, lat, lon, admin] = line.split("\t");
      const la = Number(lat);
      const lo = Number(lon);
      if (!name || !keys || !Number.isFinite(la) || !Number.isFinite(lo)) continue;
      const place: GeoPlace = { name, lat: la, lon: lo, admin: admin ?? "" };
      this.all.push(place);
      n++;
      for (const k of keys.split("|")) {
        push(this.exact, k, place);
        for (const s of stemsOfName(k)) if (s !== k) push(this.stems, s, place);
      }
    }
    this.size = n;
  }

  /**
   * Пункти з такою назвою (будь-яким відмінком). Порожньо — у довіднику немає.
   * `phrase` — вже нормалізована (`normName`), одне чи кілька слів.
   */
  /** Лише точний збіг форми — без відмінкових основ. */
  named(phrase: string): readonly GeoPlace[] {
    return this.exact.get(phrase) ?? [];
  }

  find(phrase: string): GeoPlace[] {
    const hit = this.exact.get(phrase);
    if (hit) return hit;
    const words = phrase.split(" ");
    const last = words[words.length - 1]!;
    const stem = [...words.slice(0, -1), stemOf(last)].join(" ");
    /*
     * Обидва списки, а не перший непорожній: «біля Ружина» має основу «ружин»,
     * і під нею в основах лише «Ружино» (Миколаївщина), а самі два Ружини
     * (Житомирщина, Волинь) — точною назвою «ружин». Перший варіант коду
     * віддавав тільки «Ружино» — однозначно й неправильно (23.10, sectorv666).
     */
    const a = this.stems.get(stem) ?? [];
    const b = this.exact.get(stem) ?? [];
    const both = b.length === 0 ? a : a.length === 0 ? b : [...new Set([...a, ...b])];
    if (both.length) return both;
    /*
     * Родовий множини з випадним голосним: «після Ріпок» (Ріпки), «в районі
     * Росішек» (Росішки), «біля Глинок». Основа такої назви — «рипк», а у
     * відмінку «рипок» — повернути «к» на місце (23.10, UkraineRadar_24_7).
     */
    const fleeting = last.match(/^(.{2,})[ое]к$/);
    if (fleeting) {
      const alt = [...words.slice(0, -1), `${fleeting[1]}к`].join(" ");
      return this.stems.get(alt) ?? this.exact.get(alt) ?? [];
    }
    return [];
  }

  /** Код області пункту, найближчого до точки, — для «Житомирщина» → код. */
  adminNear(lat: number, lon: number): string | null {
    let best: GeoPlace | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of this.all) {
      const d = (p.lat - lat) ** 2 + ((p.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best?.admin || null;
  }
}

function push(m: Map<string, GeoPlace[]>, k: string, p: GeoPlace): void {
  const list = m.get(k);
  if (!list) m.set(k, [p]);
  else if (!list.includes(p)) list.push(p);
}

let shared: Promise<Gazetteer | null> | null = null;

/**
 * Довідник із диска — один на процес. `null` — файлу немає: тоді дописи
 * каналів просто не дають точок, а не ламають конвеєр.
 */
export function loadGazetteer(): Promise<Gazetteer | null> {
  shared ??= (async () => {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dirs = [
        process.env["GEO_DATA_DIR"],
        join(process.cwd(), "assets", "geo"),
        join(process.cwd(), "..", "assets", "geo"),
      ].filter((d): d is string => typeof d === "string" && d.length > 0);
      for (const d of dirs) {
        try {
          return new Gazetteer(await readFile(join(d, "ua-places.tsv"), "utf8"));
        } catch {
          // наступний кандидат
        }
      }
      return null;
    } catch {
      return null;
    }
  })();
  return shared;
}
