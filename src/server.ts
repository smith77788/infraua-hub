import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { baseReport, probe, type SourceProbe } from "./lib/health";
import {
  isOwner,
  miniAppKeyboard,
  type BotCommand,
  parseCommand,
  parseLayersArg,
  renderHelp,
  renderLayers,
  renderNoPlatform,
  renderNotOwner,
  renderPurgeDone,
  renderPurgePreview,
  renderStart,
  renderStatus,
  renderUnknown,
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
async function adminCommand(parsed: BotCommand, ownerOk: boolean): Promise<string | null> {
  if (parsed.command !== "layers" && parsed.command !== "purge") return null;
  if (!ownerOk) return renderNotOwner();

  const { isPlatformConfigured, platformFetch } = await import("./lib/platform-client");
  if (!isPlatformConfigured()) return renderNoPlatform();

  if (parsed.command === "layers") {
    const wanted = parseLayersArg(parsed.args);
    if (wanted === "invalid")
      return "Не зрозумів. <code>/layers on</code> або <code>/layers off</code>";

    if (wanted === null) {
      const res = await platformFetch("/api/platform/settings/infra-layers", { method: "GET" });
      if (!res.ok) return `Платформа не відповіла: ${res.status}`;
      return renderLayers(res.body as never);
    }

    const res = await platformFetch("/api/platform/settings/infra-layers", {
      method: "PUT",
      body: JSON.stringify({ enabled: wanted, reason: `Telegram: ${parsed.chatId}` }),
    });
    if (!res.ok) return `Платформа відхилила зміну: ${res.status}`;
    // Кеш консолі тримає відповідь до півхвилини; скидаємо, щоб оберт ручки
    // було видно одразу, а не «десь за хвилину».
    const { forgetInfraLayersCache } = await import("./lib/infra-gate");
    forgetInfraLayersCache();
    return renderLayers(res.body as never);
  }

  const confirm = parsed.args.trim().toLowerCase();
  const res = await platformFetch("/api/platform/purge/infrastructure", {
    method: "POST",
    body: JSON.stringify(confirm === "yes" || confirm === "так" ? { confirm: true } : {}),
  });
  if (!res.ok) return `Платформа відхилила: ${res.status}`;
  const body = res.body as {
    dryRun?: boolean;
    wouldRetract?: string[];
    sourcesInGraph?: string[];
    retracted?: { source: string; nodesRemoved: number; edgesRemoved: number }[];
  };
  return body.dryRun
    ? renderPurgePreview(body.wouldRetract ?? [], body.sourcesInGraph ?? [])
    : renderPurgeDone(body.retracted ?? []);
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
    await telegramSend(token, parsed.chatId, admin, undefined);
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

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // Перехоплюється до маршрутизатора: службова відповідь не має залежати
    // від того, чи зібрався застосунок.
    const pathname = new URL(request.url).pathname;

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
