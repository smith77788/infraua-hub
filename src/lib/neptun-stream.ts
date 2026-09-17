import type { Threat } from "./air";
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
 * Запобіжник проти пропущеного `remove`. За стабільного зʼєднання ціль зникає
 * саме через `remove`; але якщо його загубили в розрив до перепідключення (а
 * снапшот ще не прийшов) — ціль, якої ми не бачили 10 хв, тихо прибираємо. Поріг
 * навмисно щедрий: рій, що баражує над морем, оновлюється рідко, і його не можна
 * зняти передчасно.
 */
const STALE_TRACK_MS = 10 * 60_000;

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

type Entry = { threat: Threat; at: number };

let live = new Map<string, Entry>();
let ws: WebSocket | null = null;
let connecting = false;
let gotSnapshot = false;
let lastMessageAt = 0;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
        if (mapped) next.set(mapped.id, { threat: mapped, at: now });
      }
      live = next;
      gotSnapshot = true;
      return;
    }
    case "upsert": {
      const t = msg.data as NeptunThreat | undefined;
      if (!t || typeof t.id !== "string") return;
      const mapped = mapNeptunThreat(t);
      // `mapNeptunThreat` → null, коли ціль стала неактивною / вийшла за межі:
      // тоді прибираємо її, а не лишаємо застиглою активною.
      if (mapped) live.set(mapped.id, { threat: mapped, at: now });
      else live.delete(t.id);
      return;
    }
    case "remove": {
      const id = (msg.data as { id?: string } | undefined)?.id;
      if (typeof id === "string") live.delete(id);
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
    if (now - e.at > STALE_TRACK_MS) {
      live.delete(id);
      continue;
    }
    out.push(e.threat);
  }
  return out;
}

/** Діагностика стану мосту (для health-ендпойнта / адмін-панелі). */
export function neptunStreamStatus(): {
  connected: boolean;
  fresh: boolean;
  tracks: number;
  ageMs: number | null;
} {
  const connected = ws !== null && gotSnapshot;
  const ageMs = lastMessageAt ? Date.now() - lastMessageAt : null;
  return {
    connected,
    fresh: connected && ageMs !== null && ageMs <= FRESH_MS,
    tracks: live.size,
    ageMs,
  };
}
