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
  parseCallback,
  parseCommand,
  parseLayersArg,
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
          "user-agent":
            "InfraUA-Console/1.0 (critical infrastructure monitor; +https://github.com/smith77788/infraua-hub)",
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

async function health(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const report = baseReport();
  const body =
    url.searchParams.get("probe") === "1" ? { ...report, probes: await runProbes() } : report;
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
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
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
  if (parsed.command !== "layers" && parsed.command !== "purge" && parsed.command !== "admin") {
    return null;
  }
  if (!ownerOk) return { text: renderNotOwner() };

  const { isPlatformConfigured, platformFetch } = await import("./lib/platform-client");
  if (!isPlatformConfigured()) return { text: renderNoPlatform() };

  // Панель із кнопками: те саме, що й текстові команди, але без набирання.
  if (parsed.command === "admin") {
    const state = await layersState();
    if (!state) return { text: "Платформа не відповіла." };
    return { text: renderAdminPanel(state), keyboard: adminKeyboard(state) };
  }

  if (parsed.command === "layers") {
    const wanted = parseLayersArg(parsed.args);
    if (wanted === "invalid") {
      return { text: "Не зрозумів. <code>/layers on</code> або <code>/layers off</code>" };
    }

    if (wanted === null) {
      const state = await layersState();
      if (!state) return { text: "Платформа не відповіла." };
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
async function layersState(): Promise<LayersState | null> {
  const { platformFetch } = await import("./lib/platform-client");
  const res = await platformFetch("/api/platform/settings/infra-layers", { method: "GET" });
  return res.ok ? (res.body as LayersState) : null;
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
      const state = await layersState();
      await telegramEditMessage(
        token,
        press.chatId,
        press.messageId,
        renderPurgeDone(body.retracted ?? []),
        state ? adminKeyboard(state) : undefined,
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
        ? await layersState().then((s) => (s ? adminKeyboard(s) : undefined))
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

  const state = await layersState();
  if (!state) {
    await telegramAnswerCallback(token, press.callbackId, "Платформа не відповіла");
    return;
  }
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

  const hookUrl = `${consoleUrl(request)}/api/telegram/webhook`;
  const set = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: hookUrl,
      secret_token: secret,
      // Натискання кнопок приходять окремим типом — без цього бот їх не бачить.
      allowed_updates: ["message", "callback_query"],
      // Черга старих оновлень за добу мовчання нікому не потрібна.
      drop_pending_updates: true,
    }),
  });
  const setBody = (await set.json().catch(() => null)) as { description?: string } | null;

  const info = await fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`).then((r) => r.json()).catch(() => null);
  const result = (info as { result?: Record<string, unknown> } | null)?.result ?? {};

  return json({
    ok: set.ok,
    registeredTo: hookUrl,
    setWebhook: setBody?.description ?? (set.ok ? "ok" : `HTTP ${set.status}`),
    telegram: {
      // Саме ці два поля відповідають на «чому мовчав».
      url: result["url"],
      pendingUpdates: result["pending_update_count"],
      lastError: result["last_error_message"] ?? null,
      lastErrorAt: result["last_error_date"] ?? null,
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // Перехоплюється до маршрутизатора: службова відповідь не має залежати
    // від того, чи зібрався застосунок.
    const pathname = new URL(request.url).pathname;

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
