/**
 * Останній відомий знімок — щоб радар не гас, коли гасне мережа.
 *
 * ## Навіщо це архітектурно
 *
 * Наліт і погана мережа приходять разом: РЕБ, перевантажені соти, знеструмлені
 * вузли. Саме тоді, коли людина найбільше дивиться на радар, запит по цілях
 * найімовірніше не дійде — і без цього шару панель просто порожніє або кидає
 * помилку в найгіршу мить. Тут ми зберігаємо ОСТАННІЙ вдалий знімок і повертаємо
 * його, коли живий запит не вдався, — але ніколи не вдаючи, що він свіжий.
 *
 * ## Головне правило: старе НЕ вдає нового
 *
 * Це інструмент безпеки. Показати 20-хвилинну картину як «зараз» гірше, ніж не
 * показати нічого: людина вирішить, що чисто, коли вже ні. Тому знімок завжди
 * несе свій вік, старший за `maxAgeMs` не воскрешається взагалі (краще чесне
 * «звʼязку немає», ніж давно неактуальна мапа), а рівень свіжості віддається
 * назовні, щоб інтерфейс показав його гучно.
 *
 * Сховище інжектується (не тягнемо `localStorage` всередину), тож уся логіка —
 * чисті функції під тестами, і працює на сервері (SSR) без вікна.
 */

import { ageFromEpoch } from "./freshness";

/** Мінімальний контракт сховища — рівно те, що дає `localStorage`. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Snapshot<T> {
  data: T;
  /** Коли знімок узято (epoch ms). */
  at: number;
}

export type StaleLevel = "fresh" | "recent" | "stale";

export interface Staleness {
  ageMs: number;
  level: StaleLevel;
  /** Людський вік українською: «щойно», «7 хв тому». */
  label: string;
}

interface Envelope {
  v: 1;
  at: number;
  data: unknown;
}

const DEFAULT_MAX_AGE_MS = 30 * 60_000; // старший — не воскрешаємо
// За скільки знімок стає «підстарілим» / «застарілим», хв. Ті самі пороги, що
// й для живого фіду повітря: свіжість тут теж міряє РОБОТУ фіду.
const RECENT_AFTER_MIN = 3;
const STALE_AFTER_MIN = 10;

/**
 * Сховище в памʼяті — запасне для SSR і тестів, де `localStorage` немає.
 * Ніколи не кидає: у приватному режимі краще працювати без кешу, ніж падати.
 */
export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

let fallbackStore: KeyValueStore | null = null;

/**
 * Найкраще доступне сховище: `localStorage` у браузері, памʼять — усюди інде
 * (SSR, приватний режим, заблокований доступ). Один спільний memory-store на
 * процес, щоб запис і читання бачили одне одного.
 */
export function browserStore(): KeyValueStore {
  try {
    if (typeof localStorage !== "undefined") {
      const probe = "__snap_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* приватний режим / доступ заблоковано — на памʼять */
  }
  if (!fallbackStore) fallbackStore = memoryStore();
  return fallbackStore;
}

/** Записує знімок. Будь-яка похибка сховища — тиха: кеш не критичний. */
export function writeSnapshot<T>(
  store: KeyValueStore,
  key: string,
  data: T,
  now: number = Date.now(),
): void {
  try {
    const env: Envelope = { v: 1, at: now, data };
    store.setItem(key, JSON.stringify(env));
  } catch {
    /* сховище переповнене або закрите — працюємо без кешу */
  }
}

/**
 * Читає останній знімок, якщо він валідний і не старший за `maxAgeMs`.
 * `null` — немає, побитий, з майбутнього або задавній, щоб його показувати.
 */
export function readSnapshot<T>(
  store: KeyValueStore,
  key: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  now: number = Date.now(),
): Snapshot<T> | null {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch {
    return null;
  }
  if (!env || env.v !== 1 || typeof env.at !== "number" || !Number.isFinite(env.at)) return null;
  const age = now - env.at;
  // З майбутнього (годинник з'їхав) або задавнє — не показуємо.
  if (age < -60_000 || age > maxAgeMs) return null;
  return { data: env.data as T, at: env.at };
}

/** Прибирає знімок (напр. коли живі дані знову пішли й кеш більше не потрібен). */
export function dropSnapshot(store: KeyValueStore, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* байдуже */
  }
}

/**
 * Вік знімка як рівень + підпис. Пороги — ті самі, що для живого повітря
 * (підстаріле від 3 хв, застаріле від 10 хв), бо це і є вік того самого фіду.
 */
export function staleness(at: number, now: number = Date.now()): Staleness {
  const info = ageFromEpoch(at, RECENT_AFTER_MIN, STALE_AFTER_MIN, now);
  const level: StaleLevel =
    info.freshness === "stale" ? "stale" : info.freshness === "aging" ? "recent" : "fresh";
  return { ageMs: Math.max(0, now - at), level, label: info.label };
}
