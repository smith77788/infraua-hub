import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { baseReport, probe, type SourceProbe } from "./lib/health";
import {
  ADMIN_ACTIONS,
  type AdminAction,
  adminKeyboard,
  callbackToast,
  isAdminAction,
  isOwner,
  type LayersState,
  miniAppKeyboard,
  type BotCommand,
  ownerCommands,
  parseCallback,
  parseCommand,
  parseLayersArg,
  publicCommands,
  renderHelp,
  renderNoPlatform,
  renderAdminPanel,
  renderNotOwner,
  renderPurgeDone,
  renderPurgePreview,
  renderStart,
  renderStatus,
  renderUnknown,
  purgeKeyboard,
  secretMatches,
  senderId,
} from "./lib/telegram";
import { renderErrorPage } from "./lib/error-page";
import { verifyInitData } from "./lib/telegram-initdata";
import { publicOrigin } from "./lib/request-origin";
import type { Threat } from "./lib/air";
import type { AirSnapshot } from "./lib/channel-post";
import { distanceKm } from "./lib/infra-types";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

/**
 * Кеш проби. Healthcheck, що ходить у зовнішній сервіс на кожен виклик,
 * перетворює чужу недоступність на власну — Railway перезапустить справну
 * службу через те, що Overpass у поганому настрої.
 */
let probeCache: { at: number; probes: SourceProbe[] } | null = null;
const PROBE_TTL_MS = 60_000;

async function runProbes(): Promise<SourceProbe[]> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.probes;
  const probes = await Promise.all([
    probe(
      "overpass",
      "https://overpass-api.de/api/interpreter",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // Те саме представлення, що й у робочому шляху, — інакше проба
          // міряла б не те, що відбувається насправді.
          "user-agent": "InfraUA-Console/1.0 (critical infrastructure situational awareness)",
          accept: "application/json",
        },
        // Найдешевший осмислений запит: рахунок підстанцій 110 кВ+ по країні.
        // Він же відповідає на питання, скільки їх насправді.
        body:
          "data=" +
          encodeURIComponent(
            '[out:json][timeout:60];(nwr["power"="substation"]["voltage"~"^(1[1-9][0-9]{4}|[2-9][0-9]{5})"](44.2,22.0,52.4,40.3););out count;',
          ),
      },
      45_000,
    ),
    probe("usgs", "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=1"),
    probe("eonet", "https://eonet.gsfc.nasa.gov/api/v3/events?limit=1"),
  ]);
  probeCache = { at: Date.now(), probes };
  return probes;
}

/**
 * Стан вебхука очима самого Telegram — без секрету й без витоку.
 *
 * Викликає getWebhookInfo токеном, який має сервер, і повертає лише те, що
 * відповідає на «чому бот мовчить»: чи зареєстрований вебхук, скільки оновлень
 * висить у черзі, яка була остання помилка доставки. Адресу вебхука навмисно
 * НЕ повертаємо — вона тут ні до чого, а зайве назовні не показуємо.
 */
async function webhookStatus(): Promise<Record<string, unknown>> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return { registered: false, reason: "no token" };
  try {
    const info = await fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`).then((r) => r.json());
    const r = (info as { result?: Record<string, unknown> } | null)?.result ?? {};
    const hasUrl = typeof r["url"] === "string" && (r["url"] as string).length > 0;
    return {
      registered: hasUrl,
      // Чи веде вебхук на цей самий сервіс (порівнюємо лише хост, не шлях).
      pendingUpdates: r["pending_update_count"] ?? 0,
      lastError: r["last_error_message"] ?? null,
      lastErrorAt: r["last_error_date"] ?? null,
      allowedUpdates: r["allowed_updates"] ?? null,
    };
  } catch {
    return { registered: false, reason: "getWebhookInfo failed" };
  }
}

async function health(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const report = baseReport();
  let body: Record<string, unknown> = { ...report };
  if (url.searchParams.get("probe") === "1") body = { ...body, probes: await runProbes() };
  // ?telegram=1 питає Telegram про стан вебхука — діагностика «бот мовчить».
  if (url.searchParams.get("telegram") === "1") body = { ...body, webhook: await webhookStatus() };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Telegram-бот на вебхуку в цьому ж сервісі.
 *
 * Окремий сервіс під бота коштував би грошей і відрізав би його від даних, які
 * він має показувати. Публічний HTTPS-домен у консолі вже є — саме те, чого
 * вимагає Telegram.
 */
const TELEGRAM_API = "https://api.telegram.org";

function consoleUrl(request: Request): string {
  // Адреса береться з самого запиту: сервіс живе під кількома доменами
  // (Railway, Cloudflare), і зашита константа вела б із бота не туди.
  //
  // За TLS-термінуючим проксі (Railway) внутрішній request.url приходить як
  // http:// із внутрішнім хостом. Публічну адресу знають лише forwarded-
  // заголовки, які ставить сам проксі. Без цього вебхук реєструвався б на
  // http://, і Telegram його відхиляв би — саме це й тримало бота німим.
  return publicOrigin(request);
}

async function telegramSend(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!response.ok) {
    console.error("telegram sendMessage failed", response.status, await response.text());
  }
}

/**
 * Автовідання Telegram-каналу штучним інтелектом замість людини.
 *
 * Канал у стилі народних моніторів («Ванёк»): бере ті самі повітряні цілі, що
 * на карті, і сам складає пост людською мовою (channel-post.ts). Тут — лише
 * звʼязок: узяти дані, дедупнути, надіслати в канал. Уся мова й групування —
 * у чистому, покритому тестами генераторі.
 *
 * Дедуп у памʼяті інстанса: небо змінюється повільно, і без цього канал
 * спамив би той самий пост. Найгірше після редеплою — один повтор; це
 * прийнятно й не варте стороннього сховища.
 */
// Навіть коли нічого суттєво не змінилось, зрідка постимо «тримається» — щоб
// канал виглядав живим, а не мертвим. Але рідко, щоб не було відчуття дублів.
const CHANNEL_HEARTBEAT_MS = 25 * 60 * 1000;
let lastChannelPost: { signature: string; at: number; snapshot: AirSnapshot | undefined } = {
  signature: "",
  at: 0,
  snapshot: undefined,
};

/**
 * Згладжування картини каналу в часі.
 *
 * `fetchNeptunThreats` віддає лише миттєвий «активний» набір, а OSINT-звіти
 * спорадичні: ціль зникає з набору на один-два опити й повертається. Без
 * згладжування сусідні пости за 4 хвилини виглядали «категорично різними» —
 * хоча шахед за 4 хв нікуди не подівся. Тримаємо кожну нещодавно бачену ціль
 * до HOLD_MS, зливаючи близькі за типом (той самий фізичний апарат, різні
 * звіти), тож картина ЕВОЛЮЦІОНУЄ, а не стрибає, і «відбій» по області
 * настає лише після справжньої відсутності, а не через один пропущений звіт.
 */
const CHANNEL_MEMORY_HOLD_MS = 8 * 60 * 1000;
const CHANNEL_MERGE_KM = 22;
let channelThreatMemory: { threat: Threat; seenAt: number }[] = [];
function smoothChannelThreats(current: Threat[], now: number): Threat[] {
  channelThreatMemory = channelThreatMemory.filter((m) => now - m.seenAt < CHANNEL_MEMORY_HOLD_MS);
  for (const t of current) {
    const type = t.type ?? "unknown";
    const hit = channelThreatMemory.find(
      (m) => (m.threat.type ?? "unknown") === type && distanceKm(m.threat, t) < CHANNEL_MERGE_KM,
    );
    if (hit) {
      hit.threat = t;
      hit.seenAt = now;
    } else {
      channelThreatMemory.push({ threat: t, seenAt: now });
    }
  }
  return channelThreatMemory.map((m) => m.threat);
}

interface ChannelTickResult {
  posted: boolean;
  reason?: string;
  targets?: number;
  text?: string;
  dryRun?: boolean;
  /** HTTP-статус для відповіді ендпоінта; для інших викликачів неважливий. */
  status?: number;
}

/**
 * Надсилає пост у канал: із картинкою обстановки (sendPhoto), а без неї —
 * текстом (sendMessage). Підпис фото обмежений 1024 символами: якщо текст
 * довший (масований наліт), у підпис іде коротка шапка, а не обрізаний HTML.
 */
async function sendChannelUpdate(
  token: string,
  channel: string,
  text: string,
  targets: number,
  png: Buffer | null,
): Promise<Response> {
  if (png) {
    const caption =
      text.length <= 1024
        ? text
        : `${text.split("\n")[0]}\n<i>всього в небі: ${targets} · за даними OSINT</i>`;
    const form = new FormData();
    form.append("chat_id", channel);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "situation.png");
    return fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, { method: "POST", body: form });
  }
  return fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: channel,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
}

/**
 * Ядро автоканалу — без HTTP і без секрету. Бере ті самі цілі, що на карті,
 * складає пост і (якщо не dry-run) шле в TELEGRAM_CHANNEL_ID. Тут уся логіка;
 * її ділять три викликачі: HTTP-тик (зовнішній крон), самопланувальник (таймер
 * усередині сервера) і команда /channel у боті.
 *
 * `force` пропускає дедуп і мінімальний інтервал — для ручного /channel post.
 */
async function runChannelTick(
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<ChannelTickResult> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const channel = process.env["TELEGRAM_CHANNEL_ID"];
  if (!token) return { posted: false, reason: "TELEGRAM_BOT_TOKEN не заданий", status: 503 };
  if (!channel) return { posted: false, reason: "TELEGRAM_CHANNEL_ID не заданий", status: 503 };

  const { fetchNeptunThreats } = await import("./lib/infra.functions");
  const { renderChannelPost } = await import("./lib/channel-post");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let threats: Threat[] = [];
  try {
    threats = (await fetchNeptunThreats(controller.signal)) ?? [];
  } catch {
    threats = [];
  } finally {
    clearTimeout(timer);
  }

  // Згладжуємо картину в часі, щоб сусідні пости не «стрибали» через блимання
  // OSINT-набору. Пам'ять оновлюється щотику (навіть коли не постимо).
  const smoothed = smoothChannelThreats(threats, Date.now());

  const post = renderChannelPost(smoothed, { previous: lastChannelPost.snapshot });
  if (!post) {
    // Небо чисте. Якщо ЩОЙНО були цілі — один заспокійливий «відбій» (із чистою
    // картою), далі мовчимо. Забуваємо зріз, щоб поява цілей знову була суттєвою.
    const hadTargets = (lastChannelPost.snapshot?.targets ?? 0) > 0;
    lastChannelPost = { signature: "", at: lastChannelPost.at, snapshot: undefined };
    if (hadTargets && !opts.dryRun) {
      const { renderSituationPng } = await import("./lib/situation-image");
      const png = await renderSituationPng([]);
      const text =
        "🟢 <b>Відбій — небо чисте</b>\n\n" +
        "<i>активних цілей за OSINT наразі не фіксуємо · бережіть себе 🙏</i>";
      const res = await sendChannelUpdate(token, channel, text, 0, png);
      if (res.ok) {
        lastChannelPost = { signature: "", at: Date.now(), snapshot: undefined };
        return { posted: true, targets: 0 };
      }
    }
    return { posted: false, reason: "небо чисте" };
  }
  if (opts.dryRun) return { posted: false, dryRun: true, targets: post.targets, text: post.text };

  const now = Date.now();
  // Постимо лише коли є що сказати: суттєва зміна (нова/зникла область,
  // ескалація, помітна зміна кількості) АБО давно не було ознаки життя
  // (heartbeat). Інакше мовчимо — щоб не було дублів тієї самої картини.
  if (!opts.force) {
    const heartbeatDue = now - lastChannelPost.at >= CHANNEL_HEARTBEAT_MS;
    if (!post.material && !heartbeatDue) {
      // Зріз НЕ оновлюємо: дельту рахуємо від останнього ОПУБЛІКОВАНОГО, щоб
      // повільне наростання (по +1 за тик) зрештою набрало поріг і про нього
      // сказали, а не розчинилось у дрібних кроках.
      return { posted: false, reason: "без суттєвих змін" };
    }
  }

  // Картинка обстановки — best-effort, за тим самим згладженим набором, що й
  // текст: якщо не вийшла, шлемо текст без неї.
  const { renderSituationPng } = await import("./lib/situation-image");
  const png = await renderSituationPng(smoothed);

  const res = await sendChannelUpdate(token, channel, post.text, post.targets, png);
  if (!res.ok) {
    return { posted: false, reason: `Telegram відхилив: ${res.status}`, status: 502 };
  }
  lastChannelPost = { signature: post.signature, at: now, snapshot: post.snapshot };
  return { posted: true, targets: post.targets };
}

async function channelTick(request: Request): Promise<Response> {
  const secret = process.env["TELEGRAM_WEBHOOK_SECRET"];
  const url = new URL(request.url);
  // Той самий секрет, що боронить вебхук: тик має право смикати лише той, хто
  // налаштував бота (зовнішній планувальник із секретом в URL).
  const provided = url.searchParams.get("secret");
  if (!secretMatches(secret, provided)) return new Response("unauthorized", { status: 401 });

  const result = await runChannelTick({ dryRun: url.searchParams.get("dry") === "1" });
  const { status, ...body } = result;
  return json(body, status ?? 200);
}

/**
 * Самопланувальник каналу — щоб не залежати від зовнішнього крона.
 *
 * Консоль на Railway запускається живим Node-процесом (`node
 * .output/server/index.mjs`), тож таймер усередині сервера працює, поки живий
 * процес. Без TELEGRAM_CHANNEL_ID — no-op (штатний стан). Інстанс один
 * (1 replica), тож дубль-постів немає; дедуп за підписом і мінімальний інтервал
 * усередині runChannelTick страхують і тут. `unref` — щоб таймер не заважав
 * коректному завершенню процесу; HTTP-сервер і так тримає цикл подій живим.
 */
const CHANNEL_TICK_EVERY_MS = 5 * 60 * 1000;
let channelTimer: ReturnType<typeof setInterval> | null = null;
function startChannelScheduler(): void {
  if (channelTimer) return;
  if (!process.env["TELEGRAM_CHANNEL_ID"] || !process.env["TELEGRAM_BOT_TOKEN"]) return;
  const tick = () => {
    runChannelTick().catch((e) => console.error("channel tick failed", e));
  };
  // Перший постинг незабаром після старту, далі — за інтервалом.
  const warmup = setTimeout(tick, 20_000);
  (warmup as unknown as { unref?: () => void }).unref?.();
  channelTimer = setInterval(tick, CHANNEL_TICK_EVERY_MS);
  (channelTimer as unknown as { unref?: () => void }).unref?.();
}
startChannelScheduler();

/**
 * Відповідь на натискання кнопки.
 *
 * Обовʼязкова: без неї Telegram тримає на кнопці годинник, доки не вирішить,
 * що бот не працює. `show_alert` не вмикаємо — спливного напису досить, а
 * модальне вікно на кожен дотик дратує.
 */
async function telegramAnswerCallback(
  token: string,
  callbackId: string,
  text: string,
): Promise<void> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: text.slice(0, 200) }),
  });
  if (!response.ok) {
    console.error("telegram answerCallbackQuery failed", response.status, await response.text());
  }
}

/**
 * Перемальовує саму панель, а не шле нову.
 *
 * Інакше кожен дотик лишав би в чаті ще одну панель, і за хвилину їх десяток —
 * причому старі показують застарілий стан і так само мають робочі кнопки.
 */
async function telegramEditMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    // «message is not modified» — це не помилка: стан не змінився, і Telegram
    // відмовляється переписувати те саме. Кнопка вже відповіла спливним написом.
    if (!body.includes("message is not modified")) {
      console.error("telegram editMessageText failed", response.status, body);
    }
  }
}

/** Живі дані для /status. Тільки дешеві джерела: вебхук не має чекати хвилину. */
async function situationBrief(request: Request) {
  const alarms: string[] = [];
  let eventsLastDay = 0;
  const sources: { name: string; ok: boolean }[] = [];

  try {
    const res = await fetch("https://ubilling.net.ua/aerialalerts/?json");
    const data = (await res.json()) as { states?: Record<string, { alertnow?: boolean }> };
    for (const [name, state] of Object.entries(data.states ?? {})) {
      if (state?.alertnow) alarms.push(name.replace(/ область$/, ""));
    }
    sources.push({ name: "Тривоги", ok: true });
  } catch {
    sources.push({ name: "Тривоги", ok: false });
  }

  try {
    const since = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const res = await fetch(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${since}&limit=200`,
    );
    const data = (await res.json()) as { features?: unknown[] };
    eventsLastDay = data.features?.length ?? 0;
    sources.push({ name: "USGS", ok: true });
  } catch {
    sources.push({ name: "USGS", ok: false });
  }

  return { alarmRegions: alarms, eventsLastDay, sources, consoleUrl: consoleUrl(request) };
}

/**
 * Адміністративні команди бота.
 *
 * Живуть тут, а не в `lib/telegram.ts`, бо потребують мережі: вимикач і граф
 * лежать на платформі. Чиста частина (розбір, тексти, перевірка власника) —
 * там і покрита тестами; тут лише звʼязок.
 *
 * Вимикач мусить жити на платформі, а не в змінній оточення консолі, з простої
 * причини: Worker не може переписати власне оточення, тож команда з чату
 * змінити змінну не здатна. Платформа має диск, і саме тому ручка там.
 */
async function adminCommand(
  parsed: BotCommand,
  ownerOk: boolean,
): Promise<{ text: string; keyboard?: unknown } | null> {
  if (
    parsed.command !== "layers" &&
    parsed.command !== "purge" &&
    parsed.command !== "admin" &&
    parsed.command !== "channel"
  ) {
    return null;
  }
  if (!ownerOk) return { text: renderNotOwner() };

  // Автоканал не залежить від платформи — керується прямо тут. `/channel`
  // показує прев'ю поста (нічого не шле), `/channel post` — постить зараз.
  // Так власник тестує й публікує з телефона, без браузера й секрету в URL.
  if (parsed.command === "channel") {
    const arg = parsed.args.trim().toLowerCase();
    const force = arg === "post" || arg === "пост" || arg === "постити";
    const r = await runChannelTick({ dryRun: !force, force });
    if (r.dryRun) {
      return {
        text:
          "🧪 <b>Прев'ю поста в канал</b> (не надіслано):\n\n" +
          (r.text ?? "") +
          "\n\n— щоб надіслати зараз: <code>/channel post</code>",
      };
    }
    if (r.posted) return { text: `✅ Надіслано в канал. Цілей у пості: ${r.targets}.` };
    return { text: `Не надіслано: ${r.reason}.` };
  }

  const { isPlatformConfigured, platformFetch } = await import("./lib/platform-client");
  if (!isPlatformConfigured()) return { text: renderNoPlatform() };

  // Панель із кнопками: те саме, що й текстові команди, але без набирання.
  if (parsed.command === "admin") {
    const { state, status, error } = await layersState();
    if (!state) return { text: platformError(status, error) };
    return { text: renderAdminPanel(state), keyboard: adminKeyboard(state) };
  }

  if (parsed.command === "layers") {
    const wanted = parseLayersArg(parsed.args);
    if (wanted === "invalid") {
      return { text: "Не зрозумів. <code>/layers on</code> або <code>/layers off</code>" };
    }

    if (wanted === null) {
      const { state, status, error } = await layersState();
      if (!state) return { text: platformError(status, error) };
      return { text: renderAdminPanel(state), keyboard: adminKeyboard(state) };
    }

    const res = await platformFetch("/api/platform/settings/infra-layers", {
      method: "PUT",
      body: JSON.stringify({ enabled: wanted, reason: `Telegram: ${parsed.chatId}` }),
    });
    if (!res.ok) return { text: `Платформа відхилила зміну: ${res.status}` };
    // Кеш консолі тримає відповідь до півхвилини; скидаємо, щоб оберт ручки
    // було видно одразу, а не «десь за хвилину».
    const { forgetInfraLayersCache } = await import("./lib/infra-gate");
    forgetInfraLayersCache();
    const state = res.body as LayersState;
    return { text: renderAdminPanel(state), keyboard: adminKeyboard(state) };
  }

  const confirm = parsed.args.trim().toLowerCase();
  const res = await platformFetch("/api/platform/purge/infrastructure", {
    method: "POST",
    body: JSON.stringify(confirm === "yes" || confirm === "так" ? { confirm: true } : {}),
  });
  if (!res.ok) return { text: `Платформа відхилила: ${res.status}` };
  const body = res.body as {
    dryRun?: boolean;
    wouldRetract?: string[];
    sourcesInGraph?: string[];
    retracted?: { source: string; nodesRemoved: number; edgesRemoved: number }[];
  };
  if (!body.dryRun) return { text: renderPurgeDone(body.retracted ?? []) };

  const targets = body.wouldRetract ?? [];
  return {
    text: renderPurgePreview(targets, body.sourcesInGraph ?? []),
    ...(targets.length > 0 ? { keyboard: purgeKeyboard() } : {}),
  };
}

/** Поточний стан вимикача з платформи. `null` — платформа не відповіла. */
async function layersState(): Promise<{
  state: LayersState | null;
  status: number;
  error?: string;
}> {
  const { platformFetch } = await import("./lib/platform-client");
  const res = await platformFetch("/api/platform/settings/infra-layers", { method: "GET" });
  return res.ok
    ? { state: res.body as LayersState, status: res.status }
    : { state: null, status: res.status, ...(res.error ? { error: res.error } : {}) };
}

/**
 * Людське пояснення, чому платформа не відповіла, з кодом.
 *
 * «Платформа не відповіла» без коду — це те саме, що «бот мовчить»: змушує
 * гадати. 404 означає, що сервіс платформи не оновлений (він не автодеплоїться);
 * 401/403 — розбіжність ключа; 0 — недоступний хост.
 */
function platformError(status: number, error?: string): string {
  if (status === 404) {
    return "Платформа відповіла 404: сервіс platform-api не має цього маршруту — його треба передеплоїти вручну (він не оновлюється автоматично).";
  }
  if (status === 401 || status === 403)
    return `Платформа відхилила ключ (${status}). Перевірте PLATFORM_API_KEY.`;
  if (status === 0) return "Платформа недоступна: перевірте PLATFORM_API_URL.";
  return `Платформа відповіла ${status}${error ? `: ${error}` : ""}.`;
}

/**
 * Натискання кнопки адмін-панелі.
 *
 * Власник звіряється **тут**, а не лише при показі панелі: повідомлення з
 * кнопками можна переслати в інший чат, і тоді тиснути буде хтось інший. Право
 * дає той, хто натиснув, а не той, кому колись показали.
 */
async function handleAdminPress(
  token: string,
  press: ReturnType<typeof parseCallback>,
): Promise<void> {
  if (!press) return;
  if (!isAdminAction(press.data)) {
    await telegramAnswerCallback(token, press.callbackId, "Невідома дія");
    return;
  }
  if (!isOwner(press.userId, process.env["TELEGRAM_OWNER_ID"])) {
    await telegramAnswerCallback(token, press.callbackId, "Лише для власника розгортання");
    return;
  }

  const { isPlatformConfigured, platformFetch } = await import("./lib/platform-client");
  if (!isPlatformConfigured()) {
    await telegramAnswerCallback(token, press.callbackId, "Платформа не налаштована");
    return;
  }

  const action = press.data as AdminAction;

  if (action === ADMIN_ACTIONS.purgePreview || action === ADMIN_ACTIONS.purgeConfirm) {
    const confirming = action === ADMIN_ACTIONS.purgeConfirm;
    const res = await platformFetch("/api/platform/purge/infrastructure", {
      method: "POST",
      body: JSON.stringify(confirming ? { confirm: true } : {}),
    });
    if (!res.ok) {
      await telegramAnswerCallback(token, press.callbackId, `Платформа відхилила: ${res.status}`);
      return;
    }
    const body = res.body as {
      wouldRetract?: string[];
      sourcesInGraph?: string[];
      retracted?: { source: string; nodesRemoved: number; edgesRemoved: number }[];
    };

    await telegramAnswerCallback(
      token,
      press.callbackId,
      callbackToast(action, {
        enabled: false,
        permitted: false,
        switchedOn: false,
      }),
    );

    if (confirming) {
      const after = await layersState();
      await telegramEditMessage(
        token,
        press.chatId,
        press.messageId,
        renderPurgeDone(body.retracted ?? []),
        after.state ? adminKeyboard(after.state) : undefined,
      );
      return;
    }

    const nothing = (body.wouldRetract ?? []).length === 0;
    await telegramEditMessage(
      token,
      press.chatId,
      press.messageId,
      renderPurgePreview(body.wouldRetract ?? [], body.sourcesInGraph ?? [], true),
      // Кнопки підтвердження тільки коли є що підтверджувати: «прибрати нічого»
      // з кнопкою «Так, прибрати» — це пропозиція зробити ніщо.
      nothing
        ? await layersState().then((r) => (r.state ? adminKeyboard(r.state) : undefined))
        : purgeKeyboard(),
    );
    return;
  }

  if (action === ADMIN_ACTIONS.layersOn || action === ADMIN_ACTIONS.layersOff) {
    const enabled = action === ADMIN_ACTIONS.layersOn;
    const res = await platformFetch("/api/platform/settings/infra-layers", {
      method: "PUT",
      body: JSON.stringify({ enabled, reason: `Telegram: кнопка (${press.userId})` }),
    });
    if (!res.ok) {
      await telegramAnswerCallback(token, press.callbackId, `Платформа відхилила: ${res.status}`);
      return;
    }
    const state = res.body as LayersState;
    const { forgetInfraLayersCache } = await import("./lib/infra-gate");
    forgetInfraLayersCache();
    await telegramAnswerCallback(token, press.callbackId, callbackToast(action, state));
    await telegramEditMessage(
      token,
      press.chatId,
      press.messageId,
      renderAdminPanel(state),
      adminKeyboard(state),
    );
    return;
  }

  const refreshed = await layersState();
  if (!refreshed.state) {
    await telegramAnswerCallback(
      token,
      press.callbackId,
      platformError(refreshed.status, refreshed.error),
    );
    return;
  }
  const state = refreshed.state;
  await telegramAnswerCallback(token, press.callbackId, callbackToast(action, state));
  await telegramEditMessage(
    token,
    press.chatId,
    press.messageId,
    renderAdminPanel(state),
    adminKeyboard(state),
  );
}

async function telegramWebhook(request: Request): Promise<Response> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const secret = process.env["TELEGRAM_WEBHOOK_SECRET"];

  // Адреса вебхука не таємниця, тож без перевірки секрету будь-хто може
  // надсилати підроблені оновлення. Відповідаємо 401 і нічого не робимо.
  if (!secretMatches(secret, request.headers.get("x-telegram-bot-api-secret-token"))) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!token) return new Response("not configured", { status: 503 });

  let update: unknown = null;
  try {
    update = await request.json();
  } catch {
    // Некоректне тіло — не привід просити Telegram повторювати доставку.
    return new Response("ok", { status: 200 });
  }

  // Натискання кнопки приходить окремим типом оновлення, не повідомленням.
  const press = parseCallback(update);
  if (press) {
    await handleAdminPress(token, press);
    return new Response("ok", { status: 200 });
  }

  const parsed = parseCommand(update);
  // Telegram вважає невдачею будь-що, крім 2xx, і повторює доставку. Тому
  // навіть «нічого робити» — це 200.
  if (!parsed) return new Response("ok", { status: 200 });

  const url = consoleUrl(request);
  // Власник перевіряється за тим, ХТО надіслав, а не за чатом: chatId у групі
  // спільний, і звірка з ним відкрила б команди кожному в тій групі.
  const ownerOk = isOwner(senderId(update), process.env["TELEGRAM_OWNER_ID"]);

  const admin = await adminCommand(parsed, ownerOk);
  if (admin !== null) {
    await telegramSend(token, parsed.chatId, admin.text, admin.keyboard);
    return new Response("ok", { status: 200 });
  }

  let text: string;
  switch (parsed.command) {
    case "start":
      text = renderStart(url);
      break;
    case "help":
      text = renderHelp(url);
      break;
    case "status":
      text = renderStatus(await situationBrief(request));
      break;
    default:
      text = renderUnknown(parsed.command);
  }

  await telegramSend(token, parsed.chatId, text, miniAppKeyboard(url, parsed.chatType));
  return new Response("ok", { status: 200 });
}

/**
 * Реєстрація вебхука Telegram і його стан — за секретом, який знає лише власник.
 *
 * Це відповідь на «бот мовчить». Вебхук ніде не реєструвався автоматично, тож
 * якщо Telegram його загубив (або адреса змінилася при редеплої), оновлення
 * просто не доходять. Відкриваєш цей маршрут із секретом — він реєструє вебхук
 * на ЦЕЙ самий домен і повертає, що про бота думає сам Telegram: скільки
 * оновлень висить у черзі й яка була остання помилка доставки.
 *
 * Захист — той самий `TELEGRAM_WEBHOOK_SECRET`, що вже боронить сам вебхук:
 * його знає той, хто налаштовував бота. Ціль реєстрації завжди ЦЕЙ хост, узятий
 * із запиту, — маршрут не можна намовити перенаправити бота кудись інде.
 */
/**
 * Реєструє вебхук на цей хост і повертає стан від Telegram. Спільне тіло для
 * обох шляхів: секретного /setup і підписаного /repair із Mini App.
 */
/**
 * Реєструє перелік команд бота в Telegram (`setMyCommands`).
 *
 * Без цього меню по «/» порожнє — саме тому «команда не викликається»: її не
 * видно й не запропонує. Публічні команди ставимо в типовий scope (усім);
 * якщо задано власника — додаємо йому в особистий чат scope `chat` повний
 * перелік із /admin. Так /admin зʼявляється в меню власника й не світиться
 * стороннім. Помилка тут не має валити реєстрацію вебхука — команди вторинні.
 */
async function setBotCommands(token: string, ownerId: string | undefined): Promise<string> {
  try {
    const pub = await fetch(`${TELEGRAM_API}/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: publicCommands() }),
    });
    let ownerNote = "власник не заданий — /admin у меню не показуємо";
    if (ownerId && ownerId.trim()) {
      const chatId = Number(ownerId.trim());
      const res = await fetch(`${TELEGRAM_API}/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commands: ownerCommands(),
          scope: { type: "chat", chat_id: chatId },
        }),
      });
      ownerNote = res.ok
        ? "команди власника (з /admin) зареєстровано"
        : `власник: HTTP ${res.status}`;
    }
    return pub.ok ? `публічні команди зареєстровано; ${ownerNote}` : `публічні: HTTP ${pub.status}`;
  } catch (error) {
    console.error("setBotCommands failed", error);
    return "не вдалося зареєструвати команди";
  }
}

async function registerWebhook(token: string, secret: string | undefined, request: Request) {
  const hookUrl = `${consoleUrl(request)}/api/telegram/webhook`;
  const commands = await setBotCommands(token, process.env["TELEGRAM_OWNER_ID"]);
  const set = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: hookUrl,
      ...(secret ? { secret_token: secret } : {}),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const setBody = (await set.json().catch(() => null)) as { description?: string } | null;
  const info = await fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`)
    .then((r) => r.json())
    .catch(() => null);
  const result = (info as { result?: Record<string, unknown> } | null)?.result ?? {};
  return {
    ok: set.ok,
    registeredTo: hookUrl,
    commands,
    setWebhook: setBody?.description ?? (set.ok ? "ok" : `HTTP ${set.status}`),
    telegram: {
      url: result["url"],
      pendingUpdates: result["pending_update_count"],
      lastError: result["last_error_message"] ?? null,
      lastErrorAt: result["last_error_date"] ?? null,
    },
  };
}

/**
 * Полагодити бота з Mini App — без жодного секрету, за підписом Telegram.
 *
 * Власник відкриває Mini App і тисне кнопку; браузер шле initData, який Telegram
 * підписав ботовим токеном. Сервер звіряє підпис тим самим токеном (він у нього
 * є) і, якщо задано власника, ще й що це справді він. Далі — та сама реєстрація
 * вебхука, що й у /setup. Так людина, яка загубила секрет вебхука, все одно може
 * оживити бота одним дотиком, а чужий — не може, бо не має підпису.
 */
async function telegramRepair(request: Request): Promise<Response> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const secret = process.env["TELEGRAM_WEBHOOK_SECRET"];
  const owner = process.env["TELEGRAM_OWNER_ID"];
  if (!token) return json({ ok: false, reason: "TELEGRAM_BOT_TOKEN не заданий" }, 503);

  const body = (await request.json().catch(() => null)) as { initData?: string } | null;
  const verified = await verifyInitData(body?.initData ?? "", token);
  if (!verified.ok)
    return json({ ok: false, reason: `initData не підтверджено: ${verified.reason}` }, 401);

  // Якщо власника задано — тільки він. Якщо ні — досить справжнього підпису
  // цього бота: полагодити може лише той, хто відкрив саме цей Mini App.
  if (owner && owner.trim() && String(verified.user?.id ?? "") !== owner.trim()) {
    return json({ ok: false, reason: "лише власник розгортання може це робити" }, 403);
  }

  return json(await registerWebhook(token, secret, request));
}

async function telegramSetup(request: Request): Promise<Response> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const secret = process.env["TELEGRAM_WEBHOOK_SECRET"];

  const provided = new URL(request.url).searchParams.get("secret");
  if (!secretMatches(secret, provided)) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!token) {
    return json({ ok: false, reason: "TELEGRAM_BOT_TOKEN не заданий у змінних оточення" }, 503);
  }

  return json(await registerWebhook(token, secret, request));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Самозцілення вебхука: сервер сам реєструє свій вебхук після старту.
 *
 * Корінь «бот мовчить»: вебхук ніде не реєструвався автоматично, тож після
 * кожного редеплою Telegram лишався без адреси доставки — і бот замовкав, доки
 * хтось не зареєструє вебхук руками. Тут це робить сам сервіс: один раз на
 * інстанс, при першому ж запиті, звіряє свій вебхук і реєструє, якщо його немає
 * або він веде не сюди.
 *
 * Жодного зовнішнього вводу: токен і секрет — зі змінних оточення, хост — або з
 * явної TELEGRAM_WEBHOOK_HOST (безпечніший вибір), або з домену цього ж запиту,
 * і тільки https. Тому маршрут не можна намовити перенаправити бота кудись інде.
 *
 * Не блокує відповідь: викликається fire-and-forget, помилка лягає в лог, а не
 * ламає запит користувача.
 */
let webhookEnsured = false;

async function ensureWebhook(request: Request): Promise<void> {
  if (webhookEnsured) return;
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const secret = process.env["TELEGRAM_WEBHOOK_SECRET"];
  if (!token) return;

  // Публічний origin: явний TELEGRAM_WEBHOOK_HOST, або те, що каже проксі через
  // consoleUrl (forwarded-заголовки). Ціль завжди https.
  const envHost = process.env["TELEGRAM_WEBHOOK_HOST"]?.trim();
  const origin = envHost ? `https://${envHost}` : consoleUrl(request);
  if (!origin.startsWith("https://")) return; // не реєструємо вебхук на http

  webhookEnsured = true; // ставимо одразу: навіть якщо впаде, не спамимо Telegram щозапиту
  const target = `${origin}/api/telegram/webhook`;
  try {
    const info = await fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`).then((r) => r.json());
    const current = (info as { result?: { url?: string } } | null)?.result?.url ?? "";
    // Команди реєструємо навіть коли вебхук уже на місці: перелік міг
    // зʼявитися (ця функція) вже після того, як вебхук став правильним, тож
    // прив'язувати їх до зміни адреси не можна — інакше /admin так і не
    // зʼявиться в меню на вже налаштованому боті.
    void setBotCommands(token, process.env["TELEGRAM_OWNER_ID"]);
    if (current === target) return; // адреса вже там — лишається тільки команди вище
    await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: target,
        ...(secret ? { secret_token: secret } : {}),
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      }),
    });
  } catch (error) {
    console.error("ensureWebhook failed", error);
    webhookEnsured = false; // дозволимо спробувати ще раз наступного запиту
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // Перехоплюється до маршрутизатора: службова відповідь не має залежати
    // від того, чи зібрався застосунок.
    const pathname = new URL(request.url).pathname;

    // Самозцілення вебхука — не блокуючи відповідь.
    void ensureWebhook(request);

    if (pathname === "/api/telegram/repair" && request.method === "POST") {
      try {
        return await telegramRepair(request);
      } catch (error) {
        console.error(error);
        return json({ ok: false, reason: "internal error" }, 500);
      }
    }

    if (pathname === "/api/telegram/setup") {
      try {
        return await telegramSetup(request);
      } catch (error) {
        console.error(error);
        return json({ ok: false, reason: "internal error" }, 500);
      }
    }

    if (pathname === "/api/telegram/webhook") {
      try {
        return await telegramWebhook(request);
      } catch (error) {
        console.error(error);
        // 200 навмисно: Telegram повторював би доставку тієї самої помилки.
        return new Response("ok", { status: 200 });
      }
    }

    // Тик автоканалу: зовнішній планувальник смикає це з секретом кожні
    // кілька хвилин, і бот сам постить обстановку в канал. `?dry=1` показує
    // пост, не надсилаючи, — для перевірки без спаму в канал.
    if (pathname === "/api/telegram/channel/tick") {
      try {
        return await channelTick(request);
      } catch (error) {
        console.error(error);
        return json({ posted: false, reason: "internal error" }, 500);
      }
    }

    if (pathname === "/api/health") {
      try {
        return await health(request);
      } catch (error) {
        console.error(error);
        return new Response(JSON.stringify({ status: "error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
