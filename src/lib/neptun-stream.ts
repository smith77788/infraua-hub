import type { Threat } from "./air";
import { DriftAccuracy } from "./drift-accuracy";
import { mapNeptunThreat, type NeptunThreat } from "./neptun-map";

/**
 * Живий міст до Нептуна — трансляція польоту в реальному часі.
 *
 * Нептун віддає не лише REST-знімок `/api/v1/threats`, а й постійний потік
 * `wss://neptun.in.ua/api/v1/stream`. Один процес Railway тримає ОДНЕ зʼєднання
 * на всіх користувачів і слухає:
 *   • `snapshot` {data:{threats:[…]}} — повний стан (приходить одразу на конекті
 *     й після кожного перепідключення), яким ми ПОВНІСТЮ заміщаємо мапу;
 *   • `upsert`  {data:{…одна ціль…}} — вставити/оновити одну ціль;
 *   • `remove`  {data:{id}}          — прибрати ціль;
 *   • `heartbeat` {ts}               — кожні ~15 с, ознака що канал живий;
 *   • `alerts`                       — зони тривог (тут не використовуємо).
 *
 * Це і є «пряме джерело Нептуна»: ціль рухається пушем щосекунди, а не раз на
 * цикл опитування. `neptunThreatsCached` віддає `liveThreats()`, поки міст
 * підключений і свіжий; інакше — падає на REST. Жодного стороннього стану:
 * та сама `mapNeptunThreat`, що й REST, тож «наживо» й «з опитування» — одна
 * правда, а не дві.
 */

const STREAM_URL = "wss://neptun.in.ua/api/v1/stream";

/*
 * Якщо від каналу тиша довша за це — вважаємо міст несвіжим і віддаємо REST.
 * Хартбіт іде кожні ~15 с, тож 45 с — це три пропущені удари серця: досить, щоб
 * не смикатися на одному затику мережі, і досить мало, щоб не показувати
 * завмерлу картину як «наживо».
 */
const FRESH_MS = 45_000;

/*
 * Хто вирішує, що ціль зникла, — ДЖЕРЕЛО, а не наш годинник.
 *
 * Доти тут стояло «ціль, від якої ми 10 хв не отримували `upsert`, — прибрати».
 * Заміряно на живому потоці (2026-10-20, 02:10): Нептун показував 39 цілей, наш
 * прод — 29. Бракувало РІВНО тих, що не оновлювались понад 10 хвилин (12–19
 * хв), тоді як усі наявні оновлювались свіжіше. Нептун не повторює ціль, про
 * яку канали мовчать, — він просто тримає її на карті, поки сам не пришле
 * `remove`. Тож наш запобіжник різав саме тихі цілі, а в масований наліт тихих
 * більшість: звідси «у Нептуна майже всі, у нас малий відсоток».
 *
 * Тепер членство звіряється з повним REST-знімком того самого джерела
 * (`reconcileNeptunStream`, раз на хвилину): чого немає в знімку — того немає й
 * у нас, що є — те лишається, хай скільки воно мовчить. Це закриває і втрачений
 * `remove`, заради якого стояв старий запобіжник, — тільки правильно.
 *
 * Годинник лишається останнім рубежем, коли REST недоступний, і рахує вже час
 * САМОГО джерела (`lastSeen`), а не наш прийом. Поріг навмисно щедрий: у тому ж
 * знімку Нептун тримав ціль, не оновлювану 41 хвилину.
 */
const SOURCE_STALE_MS = 60 * 60_000;

/*
 * Вікно, в якому свіжа подія потоку важить більше за REST-знімок. Знімок може
 * відставати на кілька секунд (у замірі — на 9 подій), і без цього вікна ми б
 * стирали ціль, яку потік щойно додав, а знімок ще не встиг побачити.
 */
const RECONCILE_GRACE_MS = 90_000;

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/*
 * `streamAt` — коли ціль востаннє торкнув саме ПОТІК (0 — лише REST-звірка).
 * Вікно звірки захищає тільки події потоку: запис, який дописала сама звірка,
 * не має боронитися від наступної звірки, інакше ціль, що зникла з REST,
 * висіла б іще дві хвилини.
 */
type Entry = { threat: Threat; streamAt: number };

let live = new Map<string, Entry>();
let ws: WebSocket | null = null;
let connecting = false;
let gotSnapshot = false;
let lastMessageAt = 0;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastReconcile: { at: number; added: number; removed: number } | null = null;
/*
 * Цілі, які ПОТІК щойно прибрав. REST відстає на секунди, і без цього звірка
 * повертала б щойно прибрану ціль назад — привид до наступної звірки.
 */
const tombstones = new Map<string, number>();

function bury(id: string, at: number): void {
  live.delete(id);
  tombstones.set(id, at);
}
/*
 * Кожна нова фіксація цілі — вимір точності нашої моделі руху (див.
 * `drift-accuracy`). Потік бачить КОЖНУ фіксацію першим, тож міряти тут — і
 * повна вибірка, і нуль додаткових запитів.
 */
const accuracy = new DriftAccuracy();

function canConnect(): boolean {
  // Тільки на сервері й тільки де є глобальний WebSocket (Node ≥ 22 на Railway).
  // У браузері цей шлях не викликається, але страхуємось — клієнт не має тримати
  // апстрім-зʼєднання, тож у ньому міст просто мовчить, а споживач іде на REST.
  if (typeof WebSocket === "undefined") return false;
  if (typeof window !== "undefined") return false;
  return true;
}

/**
 * Лінива ідемпотентна ініціалізація. Безпечно кликати щоразу: якщо міст уже
 * піднятий чи піднімається — нічого не робить. Нічого не блокує.
 */
export function ensureNeptunStream(): void {
  if (!canConnect()) return;
  if (ws || connecting) return;
  connect();
}

function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connecting = true;
  gotSnapshot = false;
  let socket: WebSocket;
  try {
    socket = new WebSocket(STREAM_URL);
  } catch {
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    connecting = false;
    // Успішний конект — скидаємо затримку. Снапшот прилетить наступним.
    backoff = BACKOFF_MIN_MS;
    lastMessageAt = Date.now();
  };

  socket.onmessage = (ev: MessageEvent) => {
    lastMessageAt = Date.now();
    let msg: { type?: string; data?: unknown };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    handle(msg);
  };

  socket.onerror = () => {
    // `close` прийде слідом і зробить перепідключення; тут лише не даємо
    // необробленій події впасти в процес.
  };

  socket.onclose = () => {
    connecting = false;
    if (ws === socket) ws = null;
    gotSnapshot = false;
    scheduleReconnect();
  };
}

function handle(msg: { type?: string; data?: unknown }): void {
  const now = Date.now();
  switch (msg.type) {
    case "snapshot": {
      const arr = (msg.data as { threats?: NeptunThreat[] } | undefined)?.threats;
      if (!Array.isArray(arr)) return;
      // Повний стан — повністю заміщаємо мапу, тож зниклі цілі зникають без
      // покладання на пропущені `remove`.
      const next = new Map<string, Entry>();
      for (const t of arr) {
        const mapped = mapNeptunThreat(t);
        if (mapped) next.set(mapped.id, { threat: mapped, streamAt: now });
      }
      live = next;
      // Повний стан джерела сам каже, що є, — старі надгробки йому не указ.
      tombstones.clear();
      gotSnapshot = true;
      return;
    }
    case "upsert": {
      const t = msg.data as NeptunThreat | undefined;
      if (!t || typeof t.id !== "string") return;
      const mapped = mapNeptunThreat(t);
      // `mapNeptunThreat` → null, коли ціль стала неактивною / вийшла за межі:
      // тоді прибираємо її, а не лишаємо застиглою активною.
      if (mapped) {
        const prev = live.get(mapped.id);
        if (prev) accuracy.observe(prev.threat, mapped);
        tombstones.delete(mapped.id);
        live.set(mapped.id, { threat: mapped, streamAt: now });
      } else bury(t.id, now);
      return;
    }
    case "remove": {
      const id = (msg.data as { id?: string } | undefined)?.id;
      if (typeof id === "string") bury(id, now);
      return;
    }
    // heartbeat / alerts / інше — lastMessageAt уже оновлено, більше нічого.
    default:
      return;
  }
}

function scheduleReconnect(): void {
  if (!canConnect()) return;
  if (reconnectTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  // Не тримаємо процес живим лише заради ретраю.
  if (typeof reconnectTimer === "object" && reconnectTimer && "unref" in reconnectTimer) {
    (reconnectTimer as { unref: () => void }).unref();
  }
}

/**
 * Знімок живих цілей, АБО `null`, коли мосту не можна довіряти (не підключений,
 * ще не отримав снапшот, або замовк довше за `FRESH_MS`). `null` — це сигнал
 * `neptunThreatsCached` піти на REST, а не показати завмерлу картину як живу.
 */
export function liveThreats(): Threat[] | null {
  if (!gotSnapshot) return null;
  const now = Date.now();
  if (now - lastMessageAt > FRESH_MS) return null;
  const out: Threat[] = [];
  for (const [id, e] of live) {
    const seen = Date.parse(e.threat.lastSeen ?? "");
    if (Number.isFinite(seen) && now - seen > SOURCE_STALE_MS) {
      live.delete(id);
      continue;
    }
    out.push(e.threat);
  }
  return out;
}

/**
 * Звірка з повним REST-знімком джерела: знімок каже, ЯКІ цілі є, потік — де
 * вони зараз.
 *
 * `startedAt` — коли запит знімка вирушив. Події потоку, свіжіші за
 * `startedAt − RECONCILE_GRACE_MS`, знімок не перебиває: вони або новіші за
 * нього, або він їх іще не бачив.
 */
export function reconcileNeptunStream(rest: Threat[], startedAt: number): void {
  if (!gotSnapshot) return;
  const cutoff = startedAt - RECONCILE_GRACE_MS;
  const restIds = new Set(rest.map((t) => t.id));
  let added = 0;
  let removed = 0;
  for (const [id, e] of live) {
    if (!restIds.has(id) && e.streamAt < cutoff) {
      live.delete(id);
      removed++;
    }
  }
  for (const [id, at] of tombstones) if (at < cutoff) tombstones.delete(id);
  for (const t of rest) {
    if (tombstones.has(t.id)) continue;
    const e = live.get(t.id);
    if (!e) added++;
    if (!e || e.streamAt < cutoff) {
      if (e) accuracy.observe(e.threat, t);
      live.set(t.id, { threat: t, streamAt: e?.streamAt ?? 0 });
    }
  }
  lastReconcile = { at: startedAt, added, removed };
}

/** Діагностика стану мосту (для health-ендпойнта / адмін-панелі). */
export function neptunStreamStatus(): {
  connected: boolean;
  fresh: boolean;
  tracks: number;
  ageMs: number | null;
  /** Остання звірка з REST: коли (с тому) і скільки цілей вона повернула/прибрала. */
  reconcile: { agoSec: number; added: number; removed: number } | null;
  /** Заміряна похибка моделі руху проти нерухомої позначки — за типом курсу. */
  driftAccuracy: ReturnType<DriftAccuracy["summary"]>;
} {
  const connected = ws !== null && gotSnapshot;
  const ageMs = lastMessageAt ? Date.now() - lastMessageAt : null;
  return {
    connected,
    fresh: connected && ageMs !== null && ageMs <= FRESH_MS,
    tracks: live.size,
    ageMs,
    reconcile: lastReconcile
      ? {
          agoSec: Math.round((Date.now() - lastReconcile.at) / 1000),
          added: lastReconcile.added,
          removed: lastReconcile.removed,
        }
      : null,
    driftAccuracy: accuracy.summary(),
  };
}
