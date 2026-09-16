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
  parseChatMember,
  parseCommand,
  parseLayersArg,
  parseLocation,
  parseDocument,
  webhookUpdatesOk,
  WEBHOOK_UPDATES,
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
  escapeHtml,
  purgeKeyboard,
  parseRetryAfter,
  secretMatches,
  senderId,
} from "./lib/telegram";
import { renderErrorPage } from "./lib/error-page";
import { verifyInitData } from "./lib/telegram-initdata";
import { decideAllClear, renderPersonalAllClear } from "./lib/all-clear";
import { buildCalmProfile, renderCalmHours } from "./lib/calm-hours";
import {
  recordAlarmMinutes,
  recordAlarmStart,
  recordAlert,
  recordLead,
  renderStats,
  summarizeMonth,
  summarizeWeek,
  weeklyDue,
} from "./lib/personal-stats";
import {
  addPlace,
  decidePlaceAlert,
  markPlaceAlerted,
  placesFromLegacy,
  primaryPlace,
  removePlace,
  renderPlaceAlert,
  renderPlaces,
  validatePlaceName,
  parsePlaceTail,
  placeRadiusKm,
  MAX_PLACES,
  type MyPlace,
} from "./lib/places-mine";
import { publicOrigin } from "./lib/request-origin";
import type { Threat, ThreatType } from "./lib/air";
import type { AirSnapshot } from "./lib/channel-post";
import { channelKeyboard, oblastOf } from "./lib/channel-post";
import { distanceKm } from "./lib/infra-types";
import {
  dangerIndex,
  type PersonalAssessment,
  personalAssessment,
  verifyThreat,
} from "./lib/advisory";
import { inlineResults, parseInlineQuery } from "./lib/bot-inline";
import { renderShareCard } from "./lib/share-card";
import { rankBySafeSide } from "./lib/shelter-safe-side";
import { clampLead } from "./lib/lead-threshold";
import { droneWeather, type DroneWeatherVerdict } from "./lib/drone-weather";
import { renderFlightNight } from "./lib/flight-night";
import { matchPlace } from "./lib/places";
import {
  locationKeyboard,
  parsePersonalAction,
  preciseButton,
  renderOblastPicked,
  soundKeyboard,
  renderAlert,
  renderAskPoint,
  renderShelters,
  renderPersonal,
  personalKeyboard,
  renderPointSaved,
  renderSettings,
  settingsKeyboard,
} from "./lib/bot-personal";
import {
  accrueDay,
  beginWave,
  type DayStats,
  emptyDay,
  forecastWave,
  markOfficialAlert,
  renderQuietHold,
  WAVE_ABANDON_MS,
  renderAllClear,
  renderDigest,
  newCriticalTypes,
  renderForecast,
  updateWave,
  waveEnded,
  type WaveState,
} from "./lib/channel-wave";
import { formatDuration, kyivDate, kyivHour } from "./lib/kyiv";
import { cityAlertCaption, cityAlerts, selectFreshCityAlerts } from "./lib/city-alert";
import { oblastKeyboard, parsePickerAction } from "./lib/oblast-picker";
import { buildRoute, renderRoute, type RoutePoint } from "./lib/route";
import {
  newGroupDuty,
  parseDutyArgs,
  renderDuty,
  renderDutyHelp,
  shouldNotifyGroup,
} from "./lib/group-duty";
import { buildGeoIndex, candidatesFor } from "./lib/geo-index";
import { estimateMotion, type MotionState } from "./lib/track-filter";
import { deliver, type Envelope, Priority } from "./lib/delivery";
import { capacityFor, renderCapacity, USEFUL_WINDOW_MS } from "./lib/capacity";
import {
  oblastTransitions,
  renderAlertCleared,
  renderAlertStarted,
  updateAlertStarts,
} from "./lib/oblast-watch";
import { CRITICAL_TYPES, isNight } from "./lib/subscribers";
import { circleAlertTargets, renderRelativeAlarm, renderRelativeClear } from "./lib/circle-alerts";
import {
  detectCarrier,
  renderCarrierWarning,
  warningIsFresh,
  type CarrierWarning,
} from "./lib/carriers";
import { renderAdvice, worstAdvice } from "./lib/safety-advice";
import {
  buildBackup,
  mergeCircles,
  mergeSubscribers,
  parseBackup,
  renderBackupNote,
  renderRestoreResult,
} from "./lib/backup";
import {
  channelUrl,
  GATE_ACTION,
  gateKeyboard,
  isSubscribed,
  justLeft,
  justSubscribed,
  renderAccessOpened,
  renderGate,
  renderStillNotSubscribed,
  urlFromChat,
} from "./lib/gate";
import { COVERAGE_CAVEAT, nearestShelters } from "./lib/shelters";
import {
  canReport,
  corroborate,
  pruneReports,
  renderClusters,
  renderReportAccepted,
  type SoundReport,
} from "./lib/acoustic";
import {
  type Circle,
  makeCircleCode,
  normalizeCircleCode,
  renderCircle,
  renderCircleHelp,
  renderPeerOk,
} from "./lib/circle";
import { alertPhase, leadMinutes, renderOfficialConfirmed } from "./lib/pre-alert";
import { roleOfSource } from "./lib/osint-sources";
import { updateHistory, type FixPoint } from "./lib/track-history";
import { parseOfficialAlerts, stillAlerting } from "./lib/official-alerts";
import { channelLink, inviteLink, parseStartPayload, renderInvite } from "./lib/referral";
import {
  clampRadius,
  decideAlert,
  forgetStale,
  markAlerted,
  type Subscriber,
} from "./lib/subscribers";
import {
  allCircles,
  allDuties,
  allSubscribers,
  createCircle,
  creditInvite,
  ensureSubscriber,
  getCircle,
  dropDuty,
  getDuty,
  getSubscriber,
  putDuty,
  insertMissing,
  joinCircle,
  leaveCircle,
  putCircle,
  putSubscriber,
  readMarker,
  stats as subscriberStats,
  writeMarker,
  isDurable as subscribersDurable,
} from "./lib/subscriber-store";

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
      url: r["url"] ?? null,
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

/** Скільки чекати на відповідь Telegram, перш ніж вважати виклик мертвим. */
const TELEGRAM_TIMEOUT_MS = 15_000;

/** Стеля очікування після 429 — довше чекати немає сенсу, краще наступний обхід. */
const MAX_RETRY_AFTER_S = 30;

/**
 * Надіслати повідомлення.
 *
 * Тут закрито дві вади, і обидві — в найдорожчому шляху продукту, доставці
 * тривоги.
 *
 * **429 губився мовчки.** Telegram обмежує темп і на перевищення відповідає
 * `429` з полем `retry_after`. Оброблявся лише `403`, тож повідомлення з 429
 * писалося в лог і зникало: людина, якій ішла тривога, просто її не діставала.
 * Гірше, обхід продовжував слати в тому ж темпі, поглиблюючи обмеження. Тепер
 * чекаємо рівно стільки, скільки просить Telegram, і повторюємо ОДИН раз.
 *
 * **Не було строку.** `fetch` без таймауту може висіти як завгодно довго, а
 * обхід підписників захищений прапорцем від перекриття — тож одне зависле
 * зʼєднання зупиняло ВСІ тривоги до перезапуску процесу. Тепер у кожного
 * виклику свій строк.
 */
/**
 * `queued` — виклик із черги розсилки.
 *
 * Різниця не косметична. Поодинокий виклик (відповідь на команду) може сам
 * перечекати 429 і повторити: людина чекає на відповідь, і пауза в секунду їй
 * непомітна. Виклик із черги так робити НЕ МОЖЕ: 429 означає, що
 * перевантажений бот цілком, і чекати має вся черга, а не одне повідомлення в
 * ній. Тому тут ми лише повертаємо `retry_after` нагору — рішення ухвалює той,
 * хто бачить чергу.
 */
async function telegramSend(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: unknown,
  queued = false,
): Promise<{ ok: boolean; status: number; retryAfterSec?: number }> {
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });

  const attempt = async (): Promise<{ ok: boolean; status: number; retryAfter: number | null }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (response.ok) return { ok: true, status: response.status, retryAfter: null };
      const raw = await response.text();
      console.error("telegram sendMessage failed", response.status, raw);
      return { ok: false, status: response.status, retryAfter: parseRetryAfter(raw) };
    } catch (err) {
      // Обрив або строк. Для викликача це така сама поразка, як HTTP-помилка,
      // але статусу немає — 0 означає «не доїхало».
      console.error("telegram sendMessage failed", err);
      return { ok: false, status: 0, retryAfter: null };
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await attempt();
  if (first.ok || first.status !== 429) return { ok: first.ok, status: first.status };
  if (queued) {
    return {
      ok: false,
      status: 429,
      retryAfterSec: Math.min(first.retryAfter ?? 1, MAX_RETRY_AFTER_S),
    };
  }

  const wait = Math.min(first.retryAfter ?? 1, MAX_RETRY_AFTER_S);
  await new Promise((r) => setTimeout(r, wait * 1000));
  const second = await attempt();
  return { ok: second.ok, status: second.status };
}

/**
 * Власне імʼя бота в Telegram — потрібне для посилань-запрошень.
 *
 * Береться з `getMe`, а не з зашитої константи: бота перейменовують, і
 * посилання, що веде на старе імʼя, мовчки перестає працювати саме тоді, коли
 * його масово пересилають. Значення кешується на весь час життя процесу;
 * `TELEGRAM_BOT_USERNAME` перекриває його, коли мережа до Telegram закрита.
 */
let cachedBotUsername: string | null | undefined;
async function botUsername(token: string): Promise<string | null> {
  const fromEnv = process.env["TELEGRAM_BOT_USERNAME"]?.trim();
  if (fromEnv) return fromEnv.replace(/^@/, "");
  if (cachedBotUsername !== undefined) return cachedBotUsername;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    const body = (await res.json()) as { result?: { username?: string } };
    cachedBotUsername = body.result?.username ?? null;
  } catch {
    cachedBotUsername = null;
  }
  return cachedBotUsername;
}

/**
 * Спільний кеш повітряних цілей.
 *
 * Тепер дані потрібні двом споживачам із різним ритмом: канал прокидається раз
 * на пʼять хвилин, персональні сповіщення — щопівтори. Без спільного кешу це
 * означало б удвічі більше запитів до джерела, яке нам нічого не винне.
 */
let threatCache: { at: number; threats: Threat[] } | null = null;

/**
 * Памʼять треків — спільне джерело руху для бота й каналу.
 *
 * Джерело віддає лише поточну позицію: куди ціль летить, воно каже полем
 * `heading`, яке оновлюється рідко й нічого не каже про власну похибку. Але
 * послідовні опитування самі складаються в трек, і з нього рух ВИВОДИТЬСЯ —
 * разом із розкидом, тобто з чесною мірою невпевненості.
 *
 * Тримається в одному місці навмисно. Раніше канал вів власну історію для
 * картинки, а бот не вів жодної; два споживачі того самого факту з різною
 * памʼяттю — це два різні уявлення про те, куди летить одна ціль.
 */
const trackMemory = {
  fixes: new Map<string, FixPoint[]>(),
  motions: new Map<string, MotionState>(),
  types: new Map<string, ThreatType>(),
};

/** Скільки тримати трек після зникнення цілі з видачі. */
// Довше за оцінку руху (25 хв) навмисно: із цього самого треку складається
// картинка-реконструкція під відбоєм, а хвиля триває всю ніч.
const TRACK_KEEP_MS = 12 * 60 * 60 * 1000;

function rememberTracks(threats: readonly Threat[], now: number): void {
  trackMemory.fixes = updateHistory(trackMemory.fixes, threats, now, {
    maxAgeMs: TRACK_KEEP_MS,
    maxPoints: 60,
    minMoveKm: 1,
  });
  for (const t of threats) trackMemory.types.set(t.id, t.type ?? "unknown");
  // Оцінка рахується ОДИН раз на опитування, а не на кожного підписника: вона
  // залежить лише від цілі, і повторювати її мільйон разів було б тією самою
  // помилкою, що й повний перебір відстаней.
  const fresh = new Map<string, MotionState>();
  for (const t of threats) {
    const fixes = trackMemory.fixes.get(t.id);
    if (!fixes) continue;
    const state = estimateMotion(fixes, now, {
      type: t.type ?? "unknown",
      reportedHeading: t.heading,
    });
    if (state) fresh.set(t.id, state);
  }
  trackMemory.motions = fresh;
}

/** Рух цілі для оцінок. `null` — рух ще не спостережено. */
function motionOf(threat: Threat): MotionState | null {
  return trackMemory.motions.get(threat.id) ?? null;
}

/**
 * Офіційні тривоги — спільний кеш для каналу й `/status`.
 *
 * `null` означає «не вдалося дізнатися», і це навмисно не зводиться до
 * порожнього списку: збій джерела, прочитаний як «тривог немає», дав би
 * фальшивий відбій у каналі рівно тоді, коли перевірити його нічим.
 */
let alertsCache: { at: number; regions: string[] } | null = null;
async function fetchOfficialAlerts(maxAgeMs = 60_000): Promise<string[] | null> {
  const now = Date.now();
  if (alertsCache && now - alertsCache.at < maxAgeMs) return alertsCache.regions;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch("https://ubilling.net.ua/aerialalerts/?json", {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const regions = parseOfficialAlerts(await res.json());
    if (regions === null) return null;
    alertsCache = { at: now, regions };
    return regions;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchThreatsCached(maxAgeMs: number): Promise<Threat[]> {
  const now = Date.now();
  if (threatCache && now - threatCache.at < maxAgeMs) return threatCache.threats;
  const { fetchNeptunThreats } = await import("./lib/infra.functions");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const threats = (await fetchNeptunThreats(controller.signal)) ?? [];
    threatCache = { at: now, threats };
    // Трек росте з кожного опитування — саме тому памʼять оновлюється тут, а
    // не в котромусь зі споживачів: пропущене опитування це розрив у лінії.
    rememberTracks(threats, now);
    return threats;
  } catch {
    // Збій джерела не має стирати останню відому картину: краще дані на
    // хвилину старші, ніж «небо чисте» там, де його ніхто не перевіряв.
    return threatCache?.threats ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Погодне вікно для БпЛА над точкою — «льотна ніч».
 *
 * Окремий від консольного `getWeather` запит: той рахує погоду над Києвом і без
 * хмарності, а тут потрібні саме точка людини й хмарність (вона ховає дрон від
 * вогневих груп). Тримаємо власний короткий кеш за огрубленими координатами,
 * щоб сусідні запити не били open-meteo щоразу. Збій джерела не мовчить —
 * повертаємо оцінку з позначкою «дані неповні», яку робить сам `droneWeather`.
 */
const droneWeatherCache = new Map<string, { at: number; verdict: DroneWeatherVerdict }>();
async function fetchDroneWeather(lat: number, lon: number): Promise<DroneWeatherVerdict> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const now = Date.now();
  const cached = droneWeatherCache.get(key);
  if (cached && now - cached.at < 15 * 60 * 1000) return cached.verdict;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&current=temperature_2m,wind_speed_10m,precipitation,cloud_cover&timezone=UTC`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const data = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        wind_speed_10m?: number;
        precipitation?: number;
        cloud_cover?: number;
      };
    };
    const c = data.current;
    if (!c || typeof c.wind_speed_10m !== "number") throw new Error("no current");
    const verdict = droneWeather({
      windKmh: Math.round(c.wind_speed_10m),
      precipMm: c.precipitation ?? 0,
      cloudPct: typeof c.cloud_cover === "number" ? c.cloud_cover : undefined,
      tempC: typeof c.temperature_2m === "number" ? c.temperature_2m : undefined,
    });
    droneWeatherCache.set(key, { at: now, verdict });
    return verdict;
  } catch {
    // Погода недоступна: рахуємо на нейтральних даних, вердикт буде стриманим.
    return droneWeather({ windKmh: 15, precipMm: 0 });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Публічна видача повітряної обстановки для вбудовування.
 *
 * Той самий кешований фід, що й у консолі (тож зайвого навантаження на джерело
 * немає), приведений до публічної форми. CORS відкритий — це відкриті дані;
 * короткий кеш, бо обстановка змінюється щохвилини.
 */
async function airSnapshotResponse(): Promise<Response> {
  const { publicAirSnapshot } = await import("./lib/public-snapshot");
  const threats = await fetchThreatsCached(30_000);
  return new Response(JSON.stringify(publicAirSnapshot(threats)), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=15",
    },
  });
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

/** Стеля підпису до фото в Telegram. */
const TELEGRAM_CAPTION_LIMIT = 1024;

/**
 * Останній запобіжник довжини підпису.
 *
 * Текст уже зібрано під стелю (див. `assemblePost`), тож сюди довгий рядок
 * потрапити не має. Але Telegram відхиляє надто довгий підпис цілком — тобто
 * пост не вийде взагалі, — і мовчання гірше за обрізаний хвіст. Тому лишаємо
 * грубе відсікання як страховку, а не як спосіб роботи.
 */
function captionFor(text: string): string {
  if (text.length <= TELEGRAM_CAPTION_LIMIT) return text;
  console.error(`Підпис довший за стелю (${text.length}) — відсікаємо хвіст`);
  return `${text.slice(0, TELEGRAM_CAPTION_LIMIT - 1)}…`;
}

/** Публічна адреса карти для кнопки під постом. Немає — кнопки просто не буде. */
function publicMapUrl(): string | null {
  const explicit = process.env["PUBLIC_SITE_URL"]?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const host = process.env["TELEGRAM_WEBHOOK_HOST"]?.trim();
  return host ? `https://${host.replace(/^https?:\/\//, "").replace(/\/$/, "")}` : null;
}

/**
 * Кнопки під кожним постом каналу.
 *
 * Найважливіша частина всієї конструкції зростання: пост каналу пересилають, і
 * кнопка їде разом із ним. Людина, яка вперше побачила зведення в чужому чаті,
 * одним дотиком потрапляє до власного радара — без пошуку, без реклами.
 */
async function channelButtons(
  token: string,
): Promise<{ inline_keyboard: { text: string; url: string }[][] } | undefined> {
  return channelKeyboard(channelLink((await botUsername(token)) ?? undefined), publicMapUrl());
}

interface SentPost {
  ok: boolean;
  status: number;
  messageId: number | null;
  withPhoto: boolean;
}

/**
 * Надсилає пост у канал: із картинкою обстановки (sendPhoto), а без неї —
 * текстом (sendMessage). Повертає `message_id` — саме він дозволяє далі
 * РЕДАГУВАТИ живий пост замість того, щоб плодити нові.
 */
async function sendChannelUpdate(
  token: string,
  channel: string,
  text: string,
  targets: number,
  png: Buffer | null,
  keyboard?: unknown,
  silent = false,
): Promise<SentPost> {
  let res: Response;
  if (png) {
    const form = new FormData();
    form.append("chat_id", channel);
    form.append("caption", captionFor(text));
    form.append("parse_mode", "HTML");
    if (silent) form.append("disable_notification", "true");
    if (keyboard) form.append("reply_markup", JSON.stringify(keyboard));
    form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "situation.png");
    res = await fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, { method: "POST", body: form });
  } else {
    res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: channel,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(silent ? { disable_notification: true } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }),
    });
  }
  const body = (await res.json().catch(() => null)) as {
    result?: { message_id?: number };
  } | null;
  if (!res.ok) console.error("channel post failed", res.status);
  return {
    ok: res.ok,
    status: res.status,
    messageId: body?.result?.message_id ?? null,
    withPhoto: Boolean(png),
  };
}

/**
 * Редагує живий пост хвилі.
 *
 * Разом із текстом оновлюється й КАРТИНКА: свіжий підпис під застарілою картою
 * — це та сама неправда, тільки гірша, бо виглядає як щойно перевірена. Тому
 * коли картинка є, йде `editMessageMedia`, а не лише підпис.
 *
 * `false` означає «редагування не вдалося» — і викликач тоді шле новий пост.
 * Мовчки лишити людей із застарілим постом було б найгіршим із варіантів.
 */
async function editChannelUpdate(
  token: string,
  channel: string,
  messageId: number,
  text: string,
  targets: number,
  png: Buffer | null,
  withPhoto: boolean,
  keyboard?: unknown,
): Promise<boolean> {
  try {
    let res: Response;
    if (withPhoto && png) {
      const form = new FormData();
      form.append("chat_id", channel);
      form.append("message_id", String(messageId));
      form.append(
        "media",
        JSON.stringify({
          type: "photo",
          media: "attach://photo",
          caption: captionFor(text),
          parse_mode: "HTML",
        }),
      );
      if (keyboard) form.append("reply_markup", JSON.stringify(keyboard));
      form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "situation.png");
      res = await fetch(`${TELEGRAM_API}/bot${token}/editMessageMedia`, {
        method: "POST",
        body: form,
      });
    } else if (withPhoto) {
      res = await fetch(`${TELEGRAM_API}/bot${token}/editMessageCaption`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: channel,
          message_id: messageId,
          caption: captionFor(text),
          parse_mode: "HTML",
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }),
      });
    } else {
      res = await fetch(`${TELEGRAM_API}/bot${token}/editMessageText`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: channel,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }),
      });
    }
    if (res.ok) return true;
    const body = await res.text();
    // «не змінилось» — не збій: Telegram відмовляється переписати те саме.
    if (body.includes("message is not modified")) return true;
    console.error("channel edit failed", res.status, body.slice(0, 200));
    return false;
  } catch (error) {
    console.error("channel edit threw", error);
    return false;
  }
}

/* ─── Хвиля, відбій, підсумок доби ──────────────────────────────────────── */

/**
 * Скільки живе один пост, який редагується.
 *
 * Довша хвиля розбивається на кілька постів навмисно: пост, який редагують
 * четверту годину, не підніметься в стрічці ні в кого, хто його вже бачив, —
 * а за цей час обстановка змінилася повністю.
 */
const LIVE_POST_MAX_MS = 45 * 60 * 1000;
/** Година за Києвом, коли виходить підсумок доби. */
const DIGEST_HOUR = 9;
/** Як часто можна давати адресний сигнал по тому самому місту. */
const CITY_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Уночі дзвенить лише те, заради чого варто прокинутись.
 *
 * Канали цієї ніші будять читача сімдесят разів за ніч — і людина вимикає
 * сповіщення назавжди, після чого не почує й ракетного поста. Тому оновлення
 * по шахедах уночі приходять БЕЗ звуку (пост є, значок у списку є, дзвінка
 * немає), а ракети, балістика й КАБи дзвенять завжди. Це не косметика: це
 * різниця між каналом, у якого ввімкнені сповіщення, і каналом, у якого їх
 * вимкнули всі.
 */
function shouldPostSilently(types: ReadonlySet<ThreatType>, now: number): boolean {
  const loud =
    types.has("missile") || types.has("ballistic") || types.has("cruise") || types.has("kab");
  if (loud) return false;
  const hour = kyivHour(new Date(now));
  return hour >= 23 || hour < 7;
}

function trackLines(threats: readonly Threat[]): { type: ThreatType; points: FixPoint[] }[] {
  const byId = new Map(threats.map((t) => [t.id, t] as const));
  const out: { type: ThreatType; points: FixPoint[] }[] = [];
  for (const [id, points] of trackMemory.fixes) {
    const t = byId.get(id);
    if (!t || points.length < 2) continue;
    out.push({ type: t.type ?? "unknown", points });
  }
  return out;
}

let wave: WaveState | null = null;
let liveWithPhoto = false;
let currentDay: DayStats = emptyDay(kyivDate(new Date()));
let pendingDigest: DayStats | null = null;
let digestPostedFor: string | null = null;
/** Коли востаннє давали адресний сигнал по місту (для кулдауна). */
let cityAlertedAt: Record<string, number> = {};
/** Чи підтягнули кулдаун міст зі стійкого сховища (раз на процес). */
let cityCooldownHydrated = false;
/** Чи підтягнули стан живого поста зі стійкого сховища (раз на процес). */
let liveStateHydrated = false;
/** Коли востаннє додавали час у добову статистику. */
let lastAccrualAt = 0;
/** Коли востаннє щось зробили в каналі — надіслали пост або відредагували. */
let lastChannelTouch = 0;

function rollKyivDay(now: number): void {
  const today = kyivDate(new Date(now));
  if (currentDay.date === today) return;
  // Доба, що завершилась, чекає на свою годину — підсумок виходить уранці, а
  // не о 00:00, коли його ніхто не прочитає.
  pendingDigest = currentDay;
  currentDay = emptyDay(today);
}

async function maybeDigest(token: string, channel: string, now: number): Promise<void> {
  if (!pendingDigest) return;
  if (kyivHour(new Date(now)) < DIGEST_HOUR) return;
  const day = pendingDigest;
  pendingDigest = null;
  if (digestPostedFor === day.date) return;
  digestPostedFor = day.date;
  const text = renderDigest(day);
  if (!text) return; // тиха доба не потребує поста
  await sendChannelUpdate(token, channel, text, day.peakTargets, null, await channelButtons(token));
}

/**
 * Адресний сигнал «ціль підходить до міста» — зумована локальна карта окремим
 * постом. Це доповнення до загального поста, а не заміна: спрацьовує рідко (лише
 * на неминуче й із кулдауном по місту), тож не конкурує з живим постом хвилі й
 * не смітить у стрічці. Дзвенить завжди — заради адресного попередження людину
 * варто розбудити; в цьому весь сенс.
 *
 * Best-effort: збій зума чи Telegram не має валити тік — просто не буде цього
 * поста, а загальна картина вже пішла своїм шляхом.
 */
async function maybeCityAlert(
  token: string,
  channel: string,
  threats: readonly Threat[],
  now: number,
): Promise<void> {
  const candidates = cityAlerts(threats, undefined, { limit: 1 });
  if (candidates.length === 0) return;
  // Кулдаун по місту має пережити редеплой: інакше після кожного перезапуску
  // процесу памʼять «коли сигналили» скидається, і людину будять удруге по
  // тому самому місту. Стійка позначка (той самий том, що й підписники) —
  // джерело істини; на ефемерному сховищі тихо лишаємось на памʼяті процесу.
  if (!cityCooldownHydrated) {
    cityCooldownHydrated = true;
    const raw = await readMarker("city-cooldown");
    if (raw) {
      try {
        const stored = JSON.parse(raw) as Record<string, number>;
        cityAlertedAt = { ...stored, ...cityAlertedAt };
      } catch {
        /* бита позначка — ігноруємо, працюємо з памʼяті */
      }
    }
  }
  const { fresh, lastAlertedAt } = selectFreshCityAlerts(
    candidates,
    cityAlertedAt,
    now,
    CITY_ALERT_COOLDOWN_MS,
  );
  cityAlertedAt = lastAlertedAt;
  if (fresh.length === 0) return;
  // Записуємо ПЕРЕД надсиланням: якщо тік упаде на середині, кулдаун уже
  // зафіксовано, і повтору не буде.
  await writeMarker("city-cooldown", JSON.stringify(cityAlertedAt));

  try {
    const { renderZoomPng } = await import("./lib/situation-image");
    const keyboard = await channelButtons(token);
    for (const a of fresh) {
      const png = await renderZoomPng(threats, { lat: a.lat, lon: a.lon }, 70);
      await sendChannelUpdate(token, channel, cityAlertCaption(a), a.count, png, keyboard, false);
    }
  } catch (error) {
    console.error("city alert failed", error);
  }
}

/**
 * Дзеркальний англомовний канал.
 *
 * Найбільша аудиторія цієї ніші, до якої ніхто не дотягується, — поза країною:
 * кореспонденти, аналітики, діаспора. Вони цитують українські монітори щодня й
 * читають їх машинним перекладом, який плутає «крилаті» з крилами.
 *
 * Тут другої мови не ПЕРЕКЛАДАЮТЬ: той самий генератор складає англійський
 * пост із тих самих чисел. Тому англійський канал не може сказати іншу
 * кількість цілей чи інші області — розбіжність між мовами тут неможлива за
 * побудовою, а не за домовленістю.
 *
 * Дедуп йому не потрібен: він постить рівно тоді, коли постить український.
 * Без `TELEGRAM_CHANNEL_ID_EN` — no-op, і це штатний стан.
 */
let lastEnglishSignature = "";
async function mirrorEnglish(
  token: string,
  threats: readonly Threat[],
  png: Buffer | null,
  silent: boolean,
): Promise<void> {
  const channel = process.env["TELEGRAM_CHANNEL_ID_EN"]?.trim();
  if (!channel) return;
  try {
    const { renderChannelPost } = await import("./lib/channel-post");
    const post = renderChannelPost(threats, { lang: "en" });
    if (!post || post.signature === lastEnglishSignature) return;
    lastEnglishSignature = post.signature;
    await sendChannelUpdate(
      token,
      channel,
      post.text,
      post.targets,
      png,
      await channelButtons(token),
      silent,
    );
  } catch (error) {
    // Збій дзеркала не має чіпати основний канал: українська версія вже пішла.
    console.error("english mirror failed", error);
  }
}

/**
 * Закриває хвилю БЕЗ поста — коли відбою оголошувати нема за чим.
 *
 * Два випадки: офіційної тривоги за цю хвилю не було взагалі (відбій чого?)
 * або тривога триває вже дванадцяту годину й чекати на неї далі означає не
 * дати відбою ніколи. Обидва — мовчки: «відбою не буде» краще сказати нічим,
 * ніж постом, який прочитають як відбій.
 */
function abandonWave(reason: string): void {
  if (!wave) return;
  console.info("wave closed without all-clear:", reason);
  wave = null;
  liveWithPhoto = false;
  currentDay = { ...currentDay, waves: currentDay.waves + 1 };
}

/**
 * Відбій — і тільки після офіційного оголошення.
 *
 * Раніше тут вистачало того, що ми перестали бачити цілі. Це була помилка
 * того класу, який коштує життя: наші дані — повідомлення спостерігачів, а не
 * радар, і ціль, якої ми не бачимо, не перестає летіти. Тепер відбій виходить
 * лише тоді, коли офіційну тривогу знято в УСІХ областях, яких торкалася
 * хвиля, і лише якщо та тривога взагалі оголошувалась.
 *
 * `false` — відбою не дали (і викликач має лишити хвилю відкритою).
 */
async function closeWave(
  token: string,
  channel: string,
  now: number,
  active: readonly string[],
): Promise<boolean> {
  if (!wave) return false;
  if (!wave.officialAlertSeen) {
    abandonWave("офіційної тривоги за цю хвилю не оголошували");
    return false;
  }
  if (stillAlerting(Object.keys(wave.oblasts), active).length > 0) return false;

  const ended = wave;
  wave = null;
  liveWithPhoto = false;
  currentDay = { ...currentDay, waves: currentDay.waves + 1 };
  // Відбій винен тим, кому казали про наліт. Якщо про цю хвилю в каналі не
  // вийшло жодного поста, то й закривати нема чого — «все скінчилось» без
  // «щось почалось» читається як збій.
  if (ended.messageId === null) return false;
  // Картинка під відбоєм — не порожня карта, а РЕКОНСТРУКЦІЯ ночі: позначок
  // немає (нічого не летить), але видно всі шляхи, якими хвиля пройшла. Це те,
  // чого вранці не дає жоден монітор: одна картинка замість сімдесяти постів.
  const { renderSituationPng } = await import("./lib/situation-image");
  const routeLines = [...trackMemory.fixes.entries()]
    .filter(([, points]) => points.length >= 2)
    .map(([id, points]) => ({ type: trackMemory.types.get(id) ?? "unknown", points }));
  trackMemory.fixes = new Map();
  trackMemory.types = new Map();
  trackMemory.motions = new Map();
  const sent = await sendChannelUpdate(
    token,
    channel,
    renderAllClear(ended, now),
    ended.peakTargets,
    await renderSituationPng([], routeLines),
    await channelButtons(token),
  );
  if (sent.ok) lastChannelPost = { signature: "", at: now, snapshot: undefined };
  return sent.ok;
}

/**
 * Переписує живий пост на «цілей не бачимо, але тривога триває».
 *
 * Без цього читач лишається з постом, у якому перелічені цілі, яких уже
 * немає, — і тишу навколо прочитає як дозвіл вийти. Робиться один раз на
 * хвилю: далі текст не змінюється, поки не буде офіційного відбою.
 */
async function holdQuietNotice(
  token: string,
  channel: string,
  now: number,
  still: readonly string[],
): Promise<void> {
  if (!wave || wave.messageId === null || wave.quietNoticeAt !== null) return;
  const { renderSituationPng } = await import("./lib/situation-image");
  const ok = await editChannelUpdate(
    token,
    channel,
    wave.messageId,
    renderQuietHold(wave, still, now),
    0,
    await renderSituationPng([]),
    liveWithPhoto,
    await channelButtons(token),
  );
  if (ok) wave = { ...wave, quietNoticeAt: now };
}

/**
 * Ядро автоканалу — без HTTP і без секрету.
 *
 * Тут зібрана вся поведінка каналу як ЖИВОГО видання, а не стрічки дублів:
 *
 *  1. поки хвиля триває, один і той самий пост РЕДАГУЄТЬСЯ (текст і картинка),
 *     тож за ніч у каналі кілька постів, а не сімдесят;
 *  2. новий пост відкривається лише коли є привід — початок хвилі, поява
 *     критичного типу або те, що живий пост уже задавнився;
 *  3. відбій виходить ЛИШЕ після офіційного зняття тривоги в областях хвилі;
 *     поки вона триває, а цілей не видно, живий пост прямо каже «це не відбій»;
 *  4. уранці — підсумок доби;
 *  5. під кожним постом — кнопка «чи летить на мене», яка їде разом із
 *     пересиланням.
 *
 * `force` пропускає дедуп — для ручного `/channel post`.
 */
/**
 * Стан живого поста має пережити редеплой.
 *
 * `wave` (з `messageId` поста, який редагується) і `lastChannelPost.at` жили в
 * модульній памʼяті. На кожному перезапуску процесу вони скидались — і замість
 * того, щоб ВІДРЕДАГУВАТИ живий пост хвилі, бот постив НОВИЙ. Під час нальоту,
 * коли ми ще й часто деплоїмо, канал діставав дублі постів однієї хвилі. Тепер
 * стан лягає стійкою позначкою й підхоплюється після перезапуску — але лише
 * якщо пост ще «живий» (у межах вікна редагування); застарілий не воскрешаємо,
 * бо редагувати похований у стрічці пост уже пізно, і нова хвиля має новий пост.
 */
interface ChannelState {
  wave: WaveState | null;
  lastPostAt: number;
  /**
   * Зріз і підпис останнього поста — щоб після редеплою бот РЕДАГУВАВ живий
   * пост, а не постив новий. Без зрізу `newCriticalTypes` бачить порожнє
   * «було», тобто КОЖЕН критичний тип у небі — як щойно зʼявлений, оголошує
   * фальшиву ескалацію й тим забороняє редагування (canEdit). Саме це й давало
   * дубль поста під час хвилі одразу після перезапуску — те, що редеплой мав
   * перестати ламати.
   */
  snapshot?: AirSnapshot | undefined;
  signature?: string | undefined;
  /** Добова статистика й дедуп підсумку — щоб підсумок виходив і після редеплою. */
  currentDay?: DayStats;
  pendingDigest?: DayStats | null;
  digestPostedFor?: string | null;
}

async function hydrateLiveState(now: number): Promise<void> {
  if (liveStateHydrated) return;
  liveStateHydrated = true;
  const raw = await readMarker("live-post");
  if (!raw) return;
  try {
    const s = JSON.parse(raw) as Partial<ChannelState>;
    if (s.wave && typeof s.lastPostAt === "number" && now - s.lastPostAt <= LIVE_POST_MAX_MS) {
      wave = s.wave;
      // Разом із живим постом відновлюємо його зріз і підпис: інакше перший же
      // тік після редеплою бачить фальшиву ескалацію (порожнє «було») і постить
      // НОВИЙ пост замість того, щоб відредагувати відновлений живий.
      lastChannelPost = {
        signature: typeof s.signature === "string" ? s.signature : "",
        at: s.lastPostAt,
        snapshot: s.snapshot,
      };
    }
    // Добова статистика й дедуп підсумку теж мають пережити редеплой: інакше
    // підсумок доби не виходить, якщо перезапуск стався між зміною доби і 9:00
    // (pendingDigest скидався в null), а накопичення доби фрагментувалось.
    // Далі rollKyivDay сам розбереться зі зміною доби, а digestPostedFor не дасть
    // подвоїти підсумок.
    if (s.currentDay && typeof s.currentDay.date === "string") currentDay = s.currentDay;
    if (s.pendingDigest !== undefined) pendingDigest = s.pendingDigest;
    if (typeof s.digestPostedFor === "string") digestPostedFor = s.digestPostedFor;
  } catch {
    /* бита позначка — ігноруємо, починаємо з чистого стану */
  }
}

async function runChannelTick(
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<ChannelTickResult> {
  // Сухий прогін лише ПОКАЗУЄ, що постили б — стан не чіпає й не зберігає.
  if (opts.dryRun) return runChannelTickCore(opts);
  await hydrateLiveState(Date.now());
  try {
    return await runChannelTickCore(opts);
  } finally {
    const state: ChannelState = {
      wave,
      lastPostAt: lastChannelPost.at,
      snapshot: lastChannelPost.snapshot,
      signature: lastChannelPost.signature,
      currentDay,
      pendingDigest,
      digestPostedFor,
    };
    await writeMarker("live-post", JSON.stringify(state));
  }
}

async function runChannelTickCore(
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<ChannelTickResult> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const channel = process.env["TELEGRAM_CHANNEL_ID"];
  if (!token) return { posted: false, reason: "TELEGRAM_BOT_TOKEN не заданий", status: 503 };
  if (!channel) return { posted: false, reason: "TELEGRAM_CHANNEL_ID не заданий", status: 503 };

  const { renderChannelPost } = await import("./lib/channel-post");
  const now = Date.now();
  const threats = await fetchThreatsCached(60_000);

  // Згладжуємо картину в часі, щоб сусідні пости не «стрибали» через блимання
  // OSINT-набору. Пам'ять оновлюється щотику (навіть коли не постимо).
  const smoothed = smoothChannelThreats(threats, now);
  // Трек складається з послідовних опитувань — тому історію оновлюємо щотику,
  // навіть коли не постимо: пропущений тик — це розрив у лінії.
  // Довший строк і більше точок, ніж на карті: тут трек має пережити цілу
  // нічну хвилю, бо з нього складається картинка під відбоєм.
  // Історію веде спільна памʼять треків (rememberTracks) — та сама, з якої
  // рахується рух для персональних оцінок. Два споживачі того самого факту з
  // власними копіями історії — це два різні уявлення про одну ціль.
  // Адресний сигнал по місту — незалежно від того, чи загальний пост «суттєвий»:
  // ціль на підльоті варта окремого попередження навіть без зміни оглядової
  // картини. Власний кулдаун усередині не дає йому смітити.
  if (!opts.dryRun) await maybeCityAlert(token, channel, smoothed, now);
  const forecast = renderForecast(forecastWave(smoothed));
  /*
   * Стеля підпису задається ТУТ, бо пост іде підписом до картинки.
   *
   * Раніше він рендерився без обмеження, а перевищення різалося вже перед
   * відправкою — і різалося тупо, лишаючи шапку й підвал. У каналі це давало
   * «14 цілей у небі» без жодної названої області саме тоді, коли наліт
   * великий. Тепер обмеження знає той, хто збирає текст, і жертвує спершу
   * найменш цінним (див. assemblePost).
   */
  const post = renderChannelPost(smoothed, {
    previous: lastChannelPost.snapshot,
    ...(forecast ? { forecast } : {}),
    maxChars: TELEGRAM_CAPTION_LIMIT,
  });

  if (!opts.dryRun) rollKyivDay(now);

  if (!post) {
    // Цілей не бачимо. Це ще НЕ відбій: наші дані — повідомлення спостерігачів,
    // а не радар. Забуваємо зріз, щоб поява цілей знову була суттєвою.
    lastChannelPost = { signature: "", at: lastChannelPost.at, snapshot: undefined };
    if (opts.dryRun) return { posted: false, reason: "цілей не бачимо" };

    // Годинник добової статистики йде і в тиші — інакше після кількох тихих
    // годин перший же гучний тик дорахував би їх як гучні.
    lastAccrualAt = now;
    await maybeDigest(token, channel, now);
    await maybeBackup(token, now);
    await maybeWeeklySummary(token, now);
    if (!wave) return { posted: false, reason: "небо чисте" };

    const active = await fetchOfficialAlerts();
    if (active === null) {
      // Стан офіційних тривог невідомий. Мовчимо: відбій, виданий наосліп,
      // гірший за відсутність відбою.
      return { posted: false, reason: "джерело офіційних тривог не відповідає" };
    }

    const still = stillAlerting(Object.keys(wave.oblasts), active);
    if (still.length === 0) {
      const posted = await closeWave(token, channel, now, active);
      if (posted) {
        lastChannelTouch = now;
        return { posted: true, targets: 0 };
      }
      return { posted: false, reason: "відбою не давали: тривоги за цю хвилю не було" };
    }

    // Тривога триває. Найнебезпечніший момент: у читача на екрані пост із
    // цілями, яких уже немає. Переписуємо живий пост на чесний стан — один раз.
    if (waveEnded(wave, now)) await holdQuietNotice(token, channel, now, still);
    if (now - wave.lastActiveAt > WAVE_ABANDON_MS) {
      abandonWave(`офіційна тривога триває понад 12 год: ${still.join(", ")}`);
    }
    return { posted: false, reason: `чекаємо на офіційний відбій: ${still.join(", ")}` };
  }

  if (opts.dryRun) return { posted: false, dryRun: true, targets: post.targets, text: post.text };

  const escalation = newCriticalTypes(lastChannelPost.snapshot, post.snapshot);
  wave = updateWave(wave ?? beginWave(now), post.snapshot, now);
  // Запам'ятовуємо факт офіційної тривоги, поки вона триває: саме він дає
  // право оголосити відбій, коли її знімуть. Недоступне джерело тут не біда —
  // прапорець виставиться на наступному тику.
  wave = markOfficialAlert(wave, (await fetchOfficialAlerts()) ?? []);
  // Нова хвиля активності скасовує сказане «цілей не бачимо».
  if (wave.quietNoticeAt !== null) wave = { ...wave, quietNoticeAt: null };
  // Хвилини беруться з годинника, а не з очікуваного кроку планувальника: тик
  // смикає і зовнішній крон, і команда /channel, і за сталим кроком «у небі
  // щось було 6 годин» вийшло б із трьох реальних. Стеля в 15 хвилин обрізає
  // прогалину після рестарту, коли між тиками минуло пів дня.
  const sinceAccrual = lastAccrualAt ? Math.min((now - lastAccrualAt) / 60_000, 15) : 0;
  lastAccrualAt = now;
  currentDay = accrueDay(currentDay, post.snapshot, sinceAccrual);
  await maybeDigest(token, channel, now);
  await maybeBackup(token, now);

  const changed = post.signature !== lastChannelPost.signature;
  // Ознака життя рахується від ОСТАННЬОГО ДОТИКУ (поста чи правки), а не від
  // створення живого поста: інакше через 25 хвилин редагувань heartbeat
  // лишався б назавжди «прострочений» і щотику змушував перемальовувати
  // картинку заради правки, яка нічого не міняє.
  const heartbeatDue = now - lastChannelTouch >= CHANNEL_HEARTBEAT_MS;
  // Редагування живого поста нікого не турбує, тож поріг для нього нижчий за
  // поріг нового поста: у стрічці нічого не зʼявляється, а пост лишається
  // правдивим. Мовчимо лише тоді, коли не змінилось узагалі нічого.
  if (!opts.force && !changed && !heartbeatDue) {
    return { posted: false, reason: "без суттєвих змін" };
  }

  // Картинка обстановки — best-effort, за тим самим згладженим набором, що й
  // текст: якщо не вийшла, шлемо текст без неї.
  const { renderSituationPng } = await import("./lib/situation-image");
  const png = await renderSituationPng(smoothed, trackLines(smoothed));
  const keyboard = await channelButtons(token);
  const types = new Set<ThreatType>(smoothed.map((t) => t.type ?? "unknown"));
  const silent = shouldPostSilently(types, now);

  const liveStale = now - lastChannelPost.at > LIVE_POST_MAX_MS;
  const canEdit = !opts.force && wave.messageId !== null && !liveStale && escalation.length === 0;

  if (canEdit && wave.messageId !== null) {
    const ok = await editChannelUpdate(
      token,
      channel,
      wave.messageId,
      post.text,
      post.targets,
      png,
      liveWithPhoto,
      keyboard,
    );
    if (ok) {
      wave = { ...wave, edits: wave.edits + 1 };
      lastChannelTouch = now;
      lastChannelPost = {
        signature: post.signature,
        at: lastChannelPost.at,
        snapshot: post.snapshot,
      };
      return { posted: true, targets: post.targets, reason: "живий пост оновлено" };
    }
    // Редагування не вдалося (пост видалили, канал переналаштували) — не
    // лишаємо читачів зі старим текстом, а відкриваємо новий.
    wave = { ...wave, messageId: null };
  }

  const sent = await sendChannelUpdate(
    token,
    channel,
    post.text,
    post.targets,
    png,
    keyboard,
    silent,
  );
  if (!sent.ok) {
    return { posted: false, reason: `Telegram відхилив: ${sent.status}`, status: 502 };
  }
  wave = { ...wave, messageId: sent.messageId, edits: 0 };
  liveWithPhoto = sent.withPhoto;
  lastChannelTouch = now;
  lastChannelPost = { signature: post.signature, at: now, snapshot: post.snapshot };
  await mirrorEnglish(token, smoothed, png, silent);
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

/* ─── Гейт підписки на канал ────────────────────────────────────────────── */

/**
 * Перевірка членства з коротким кешем.
 *
 * `getChatMember` — це запит на КОЖЕН дотик кнопки, а їх у тривогу буває
 * багато. Хвилинний кеш прибирає лавину, не роблячи гейт дірявим: людина, яка
 * щойно підписалась, чекає щонайбільше хвилину, а «Я підписався» скидає кеш
 * для неї одразу.
 *
 * `null` означає «перевірити не вдалося» — і воно НЕ зводиться до «не
 * підписаний»: збій на нашому боці не має коштувати комусь сповіщення.
 */
const GATE_TTL_MS = 60 * 1000;
const gateCache = new Map<number, { at: number; ok: boolean }>();

async function checkSubscription(token: string, userId: number): Promise<boolean | null> {
  const channel = process.env["TELEGRAM_CHANNEL_ID"]?.trim();
  if (!channel) return null; // канал не налаштований — гейта немає
  const cached = gateCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.at < GATE_TTL_MS) return cached.ok;
  try {
    const res = await fetch(
      `${TELEGRAM_API}/bot${token}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${userId}`,
    );
    const body = (await res.json()) as {
      ok?: boolean;
      result?: { status?: string; is_member?: boolean };
    };
    if (!body.ok || !body.result) return null;
    const ok = isSubscribed(body.result.status, body.result.is_member);
    gateCache.set(userId, { at: now, ok });
    return ok;
  } catch {
    // Telegram не відповів. Пускаємо: інструмент безпеки не має замикатись
    // через власний збій.
    return null;
  }
}

/**
 * Чи пускати далі. `null` у відповіді — «пускаємо» (див. запобіжник 1 у gate.ts).
 *
 * Повертає готову відповідь-гейт, коли пускати не можна, і `null`, коли можна.
 */
/**
 * Публічна адреса каналу, спитана в Telegram і закешована.
 *
 * Питаємо, а не виводимо з налаштування: у проді канал заданий числом, з якого
 * посилання не зробити, і гейт через це мовчки не працював. Кеш назавжди —
 * адреса каналу не змінюється частіше, ніж перезапускається процес; `null`
 * теж кешуємо, щоб не стукати в Telegram на кожну команду.
 */
let cachedChannelUrl: { url: string | null } | null = null;

async function channelPublicUrl(token: string): Promise<string | null> {
  const configured = channelUrl(process.env["TELEGRAM_CHANNEL_ID"]);
  if (configured) return configured;
  const channel = process.env["TELEGRAM_CHANNEL_ID"]?.trim();
  if (!channel) return null;
  if (cachedChannelUrl) return cachedChannelUrl.url;
  try {
    const res = await fetch(
      `${TELEGRAM_API}/bot${token}/getChat?chat_id=${encodeURIComponent(channel)}`,
    );
    const body = (await res.json()) as { ok?: boolean; result?: Record<string, unknown> };
    const url = body.ok && body.result ? urlFromChat(body.result) : null;
    cachedChannelUrl = { url };
    return url;
  } catch {
    // Не кешуємо збій: наступна спроба має бути справжньою спробою.
    return null;
  }
}

async function subscriptionGate(
  token: string,
  userId: number | undefined,
): Promise<{ text: string; keyboard: unknown } | null> {
  const url = await channelPublicUrl(token);
  // Без публічного посилання гейт неможливий по суті: ми не можемо показати
  // людині, КУДИ підписуватись. Замкнути її в цьому стані було б знущанням.
  if (!url || typeof userId !== "number") return null;
  const ok = await checkSubscription(token, userId);
  if (ok === null || ok) return null;
  return { text: renderGate(url), keyboard: gateKeyboard(url) };
}

/** Натискання «Я підписався». `false` — кнопка не наша. */
async function handleGatePress(
  token: string,
  press: NonNullable<ReturnType<typeof parseCallback>>,
): Promise<boolean> {
  if (press.data !== GATE_ACTION) return false;
  const userId = press.userId;
  if (typeof userId === "number") gateCache.delete(userId); // перевіряємо наново
  const gate = await subscriptionGate(token, userId);
  if (gate) {
    await telegramAnswerCallback(token, press.callbackId, "Поки не бачу підписки");
    await telegramSend(token, press.chatId, renderStillNotSubscribed());
    return true;
  }
  await telegramAnswerCallback(token, press.callbackId, "Дякуємо! Радар відкрито");
  await telegramSend(token, press.chatId, renderAskPoint(), askPointKeyboard());
  return true;
}

/* ─── Персональний радар: «чи летить на мене» ───────────────────────────── */

/**
 * Точка людини і те, що з неї випливає.
 *
 * Одна функція на всі входи (команда, кнопка, геолокація), бо розрахунок має
 * бути той самий: три різні шляхи до трьох трохи різних відповідей — це те, як
 * зʼявляються розбіжності, яких потім ніхто не може відтворити.
 */
/**
 * Акустичні доклади — у памʼяті процесу, і це свідомо.
 *
 * Доклад живе пів години й після цього нічого не означає. Класти таке на диск
 * означало б платити записом за дані, які застаріють раніше, ніж їх прочитають;
 * втрата при редеплої коштує рівно тих кількох хвилин, які вони й мали жити.
 */
let soundReports: SoundReport[] = [];

function recordSound(report: SoundReport): void {
  soundReports = pruneReports([...soundReports, report], report.at);
}

/**
 * Наскільки вірити провідній цілі — рядком, який читається без словника.
 *
 * Модулі верифікації в проєкті були давно, але жодна відповідь бота їх не
 * показувала: людина бачила «шахед за 12 км» і не могла знати, чи це три
 * незалежні канали, чи одне непідтверджене повідомлення.
 */
function trustLine(assess: PersonalAssessment): string | null {
  const lead = assess.nearest.find((n) => n.inbound) ?? assess.nearest[0];
  if (!lead) return null;
  return `джерела: ${verifyThreat(lead.threat, roleOfSource).label}`;
}

async function personalCard(
  sub: Subscriber,
  opts: { withOk?: boolean } = {},
): Promise<{ text: string; keyboard: unknown } | null> {
  if (!sub.point) return null;
  const threats = await fetchThreatsCached(60_000);
  const assess = personalAssessment(threats, sub.point, { radiusKm: sub.radiusKm, motionOf });
  const danger = dangerIndex(assess);
  // Чи діє офіційна тривога над точкою. `null` — джерело мовчить, і це так і
  // передається далі: невідоме не зводиться ні до «діє», ні до «знято».
  const active = await fetchOfficialAlerts();
  const officialAlert =
    active === null ? null : active.includes(oblastOf(sub.point.lat, sub.point.lon));
  const now = Date.now();
  const heard = renderClusters(corroborate(soundReports, sub.point, now));
  const live = Boolean(sub.liveUntil && sub.liveUntil > now);
  return {
    text: renderPersonal(assess, danger, sub.point.label, sub.radiusKm, {
      officialAlert,
      heard,
      live,
    }),
    keyboard: personalKeyboard(opts.withOk ? { withOk: true } : {}),
  };
}

/** Зберігає точку й одразу показує першу картку — без «надішліть /my ще раз». */
async function savePoint(
  token: string,
  chatId: number,
  lat: number,
  lon: number,
  label: string,
  live: { livePeriod: number; isUpdate: boolean } = { livePeriod: 0, isUpdate: false },
): Promise<void> {
  const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
  const now = Date.now();
  const liveUntil = live.livePeriod > 0 ? now + live.livePeriod * 1000 : (sub.liveUntil ?? null);
  const updated: Subscriber = {
    ...sub,
    point: { lat, lon, label },
    muted: false,
    liveUntil,
    // Нова точка — нова історія: сповіщення про цілі, пораховані для старої
    // точки, до нової стосунку не мають.
    lastAlertIds: [],
    lastLevel: null,
  };
  // Негайний запис: саме цю зміну найприкріше втратити при перезапуску —
  // людина щойно задала точку й вважає, що бот її знає.
  await putSubscriber(updated, true);

  // Оновлення живої точки приходить щохвилини. Писати на кожне «ви переїхали
  // на 300 метрів» означало б зробити з радара балакучого пасажира — тому
  // оновлення зберігаємо мовчки, а говоримо лише коли точку задали.
  if (live.isUpdate) return;

  await telegramSend(
    token,
    chatId,
    live.livePeriod > 0
      ? renderPointSaved(label, updated.radiusKm) +
          "\n\n📍 <b>Точка жива</b> — вона їде за вами, поки Telegram ділиться нею."
      : renderPointSaved(label, updated.radiusKm),
    // Знімаємо клавіатуру запиту точки. Без цього кнопка «Надіслати мою точку»
    // лишалась висіти внизу чату назавжди — навіть коли точку вже прийнято, і
    // читалась як «не спрацювало, тисни ще».
    { remove_keyboard: true },
  );
  const card = await personalCard(updated);
  if (card) await telegramSend(token, chatId, card.text, card.keyboard);
}

/**
 * Команди персонального радара.
 *
 * `null` — команда не наша, далі розбирається загальний перемикач.
 */
async function personalCommand(
  token: string,
  parsed: BotCommand,
  userId: number | undefined,
): Promise<{ text: string; keyboard?: unknown } | null | "handled"> {
  const { command, args, chatId, chatType } = parsed;
  const personalCommands = new Set([
    "my",
    "shelter",
    "укриття",
    "place",
    "місця",
    "місце",
    "month",
    "місяць",
    "статистика",
    "calm",
    "тихо",
    "сон",
    "сховатись",
    "radar",
    "me",
    "settings",
    "налаштування",
    "stop",
    "pause",
    "invite",
    "circle",
    "коло",
    "place",
    "місце",
    "places",
    "місця",
    "month",
    "місяць",
    "статистика",
    "route",
    "дорога",
    "ніч",
    "погода",
    "weather",
  ]);

  // У групі chatId спільний: завести там «підписника» означало б слати
  // персональні сповіщення в загальний чат і рахувати групу як людину.
  // Персональне живе в особистому чаті — так само, як і точка людини.
  if (chatType !== "private") {
    if (command === "duty" || command === "черговий") return dutyCommand(parsed, userId);
    if (command === "start") return null;
    if (!personalCommands.has(command)) return null;
    const name = (await botUsername(token)) ?? undefined;
    return {
      text: name
        ? `Персональний радар працює в особистому чаті: <a href="https://t.me/${name}?start=ch">відкрити бота</a>.`
        : "Персональний радар працює в особистому чаті з ботом.",
    };
  }

  // Черговий по чату — єдина команда, яка живе САМЕ в групі. Решта
  // персонального там не має сенсу: точка й налаштування в людини свої.
  if (command === "duty" || command === "черговий") {
    return dutyCommand(parsed, userId);
  }

  // Гейт підписки. `/stop` навмисно поза ним: можливість вимкнути сповіщення
  // не може залежати ні від чого — людина має право замовкнути бота будь-коли.
  if (GATED_COMMANDS.has(command)) {
    const gate = await subscriptionGate(token, userId);
    if (gate) return gate;
  }

  if (command === "start") {
    // Payload із `/start` — це весь механізм запрошень: хто кого привів.
    const payload = parseStartPayload(args);
    const { sub, created } = await ensureSubscriber(chatId, new Date().toISOString(), payload.ref);
    if (created && payload.ref) await creditInvite(payload.ref, chatId);
    if (created && sub.point === null && chatType === "private") {
      // Нового вітаємо не текстом про систему, а проханням точки: цінність
      // бота починається рівно там, і зайвий крок між ними коштує підписника.
      return { text: renderAskPoint(), keyboard: askPointKeyboard() };
    }
    return null; // далі спрацює звичайний renderStart
  }

  if (command === "my" || command === "radar" || command === "me") {
    const { sub } = await ensureSubscriber(chatId, new Date().toISOString());

    const named = args.trim() ? matchPlace(args.trim()) : null;
    if (named) {
      // Місто — точка сама по собі; область — лише центр, і це чесно кажемо.
      const label = named.kind === "city" ? named.name : `${named.name} (центр області)`;
      await savePoint(token, chatId, named.lat, named.lon, label);
      return "handled";
    }
    if (args.trim() && !named) {
      return {
        text: "Не впізнав місто. Напишіть, наприклад, <code>/my Кременчук</code> чи <code>/my Харків</code> — або надішліть геолокацію кнопкою нижче: так найточніше.",
        keyboard: locationKeyboard(chatType),
      };
    }
    if (!sub.point) return { text: renderAskPoint(), keyboard: locationKeyboard(chatType) };

    const resumed = sub.muted ? { ...sub, muted: false } : sub;
    if (sub.muted) await putSubscriber(resumed);
    const card = await personalCard(resumed);
    if (!card) return { text: renderAskPoint(), keyboard: askPointKeyboard() };
    return {
      text: sub.muted ? `🔔 Сповіщення знову увімкнені.\n\n${card.text}` : card.text,
      keyboard: card.keyboard,
    };
  }

  /*
   * «Куди сховатися» — свідомо ПОЗА гейтом підписки, разом зі `/stop`.
   *
   * Гейт існує, щоб канал і бот були одним цілим; це продуктове рішення й
   * воно доречне. Але поставити умову між людиною під тривогою й дорогою до
   * укриття — інша річ. Ціна помилки тут не «менше підписників», а людина,
   * яка читала екран про підписку замість того, щоб іти.
   */
  if (command === "shelter" || command === "укриття" || command === "сховатись") {
    const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
    const named = args.trim() ? matchPlace(args.trim()) : null;
    const point = named ? { lat: named.lat, lon: named.lon } : sub.point;
    if (!point) return { text: renderAskPoint(), keyboard: locationKeyboard(chatType) };
    await sendShelters(token, chatId, point);
    return "handled";
  }

  /*
   * «Льотна ніч» — погодне вікно для БпЛА над точкою людини.
   *
   * Відповідає на вечірнє питання «чи бути напоготові цієї ночі» тим, чого не
   * дає монітор цілей: не «що зараз», а наскільки погода СПРИЯЄ заходу дронів.
   * Точку можна назвати містом; без неї — просимо задати.
   */
  if (command === "ніч" || command === "погода" || command === "weather") {
    const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
    const named = args.trim() ? matchPlace(args.trim()) : null;
    const point = named ? { lat: named.lat, lon: named.lon } : sub.point;
    if (!point) return { text: renderAskPoint(), keyboard: locationKeyboard(chatType) };
    const weather = await fetchDroneWeather(point.lat, point.lon);
    return { text: renderFlightNight({ weather, rhythm: null }) };
  }

  /*
   * Мої місця — найбільша прогалина, яку закриває ця команда.
   *
   * Радар знав ОДНУ координату, а людина не живе в одній: дім, робота, батьки
   * в іншому місті, школа дитини. Питання «а там як?» будило найчастіше, і
   * відповісти на нього було нічим.
   */
  if (command === "place" || command === "місця" || command === "місце") {
    const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
    const places = placesFromLegacy(sub.point, sub.places, Date.now());
    const [verb = "", ...rest] = args.trim().split(/\s+/);
    const tail = rest.join(" ").trim();

    if (verb === "прибрати" || verb === "видалити" || verb === "remove") {
      const r = removePlace(places, tail);
      if (!r.removed) return { text: `Місця «${escapeHtml(tail)}» немає. Перелік: /place` };
      // Головне місце могло щойно зникнути — `point` має піти за новим, інакше
      // весь код, що вміє «точку людини», лишиться при видаленій координаті.
      await putSubscriber(syncPrimary({ ...sub, places: r.places }), true);
      return { text: `Прибрано: <b>${escapeHtml(r.removed.title)}</b>` };
    }

    if (verb && verb !== "перелік" && verb !== "list") {
      // `/place мама Харків` — назва, далі місто, за бажанням радіус.
      const name = validatePlaceName(verb);
      if (!name.ok) return { text: name.error ?? "Не зрозумів назву." };
      if (!tail) {
        return {
          text: `Скажіть, де це: <code>/place ${escapeHtml(name.value)} Харків</code>`,
        };
      }
      const { query, radiusKm } = parsePlaceTail(tail);
      const found = matchPlace(query);
      if (!found) {
        return { text: `Не впізнав «${escapeHtml(query)}». Напишіть місто або область.` };
      }
      const r = addPlace(
        places,
        {
          title: name.value,
          lat: found.lat,
          lon: found.lon,
          label: found.name,
          ...(radiusKm !== undefined ? { radiusKm } : {}),
        },
        Date.now(),
      );
      if (r.error) return { text: r.error };
      await putSubscriber(syncPrimary({ ...sub, places: r.places }), true);
      return {
        text: [
          `${r.replaced ? "Оновлено" : "Додано"}: <b>${escapeHtml(name.value)}</b> — ${escapeHtml(found.name)}` +
            (radiusKm !== undefined ? ` · радіус ${radiusKm} км` : ""),
          "",
          `Стежу за ${r.places.length} з ${MAX_PLACES} місць. Перелік: /place`,
        ].join("\n"),
      };
    }

    return { text: renderPlaces(places) };
  }

  /*
   * Особиста статистика окремою командою, а не всередині `/my`.
   *
   * `/my` відповідає на «що зараз» — це те, заради чого бота відкривають під
   * тривогою, і домішувати туди місячні підсумки означало б відсунути
   * терміновe заради цікавого.
   */
  if (command === "month" || command === "місяць" || command === "статистика") {
    const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
    return { text: renderStats(summarizeMonth(sub.stats, Date.now())) };
  }

  /*
   * «Коли історично тихіше» — питання, яке людина ставить собі щовечора третій
   * рік поспіль: лягати зараз чи все одно піднімуть.
   *
   * Дані беремо з платформи (там накопичення переживає перезапуски), а
   * судження про те, що вважати спокоєм, лишається тут — поруч із текстом, який
   * читає людина.
   */
  if (command === "calm" || command === "тихо" || command === "сон") {
    const { platformFetch } = await import("./lib/platform-client");
    const res = await platformFetch("/api/platform/air/buckets?days=30");
    if (!res.ok) {
      return {
        text: "Історію активності зараз не дістати — спробуйте трохи пізніше.",
      };
    }
    const body = res.body as { buckets?: { at: number; targets: number }[] } | null;
    const profile = buildCalmProfile(body?.buckets ?? []);
    return { text: renderCalmHours(profile) };
  }

  if (command === "settings" || command === "налаштування") {
    const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
    return { text: renderSettings(sub), keyboard: settingsKeyboard(sub) };
  }

  if (command === "stop" || command === "pause") {
    const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
    await putSubscriber({ ...sub, muted: true });
    return {
      text: [
        "🔕 Сповіщення на паузі.",
        "",
        "Налаштування й точка збережені — /my вмикає назад одним дотиком.",
      ].join("\n"),
    };
  }

  // Дорога: що чекає між пунктом А і Б. Питання, якого не ставив ніхто.
  if (command === "route" || command === "дорога") {
    const parts = args.split(/\s*(?:—|->|→|-)\s*/).filter(Boolean);
    if (parts.length < 2) {
      return {
        text: [
          "🛣 <b>Дорога</b>",
          "",
          "Що чекає між двома містами — по областях, із часом, коли ви там будете.",
          "",
          "<code>/route Київ - Харків</code>",
        ].join("\n"),
      };
    }
    const from = await findPlacePoint(parts[0]!.trim());
    const to = await findPlacePoint(parts[1]!.trim());
    if (!from || !to) return { text: "Не впізнав одне з міст. Спробуйте обласні центри." };
    return { text: await routeReport(from, to) };
  }

  if (command === "circle" || command === "коло") {
    return circleCommand(chatId, args, Date.now());
  }

  if (command === "invite") {
    const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
    const link = inviteLink((await botUsername(token)) ?? undefined, sub.code);
    return { text: renderInvite(link, sub.invited) };
  }

  return null;
}

/**
 * Розсилає решті кола «X у порядку».
 *
 * Один рядок кожному, і жодних координат: коло існує, щоб зняти тривогу за
 * людину, а не щоб показати, де вона. Пост із чужим місцем можна переслати —
 * і тоді він працює вже проти неї.
 */
async function broadcastOk(token: string, sub: Subscriber): Promise<void> {
  if (!sub.circle) return;
  const circle = await getCircle(sub.circle);
  if (!circle) return;
  const name = sub.displayName ?? "Хтось";
  for (const chatId of circle.members) {
    if (chatId === sub.chatId) continue;
    await telegramSend(token, chatId, renderPeerOk(name, circle.name));
    await new Promise((r) => setTimeout(r, ALERT_SEND_GAP_MS));
  }
}

/** Показує коло людини: хто відмітився, хто ще ні. */
async function circleView(sub: Subscriber, now: number): Promise<string | null> {
  if (!sub.circle) return null;
  const circle = await getCircle(sub.circle);
  if (!circle) return null;
  const views = [];
  for (const chatId of circle.members) {
    // Саме читання, без ensureSubscriber: перегляд кола не має заводити
    // підписників — інакше лічильник підписників рахував би перегляди.
    const member = await getSubscriber(chatId);
    views.push({
      chatId,
      name: member?.displayName ?? (chatId === circle.ownerChatId ? "Власник кола" : "Учасник"),
      okAt: member?.okAt ?? null,
    });
  }
  return renderCircle(circle, views, now);
}

/**
 * Команда `/circle`: створити коло, приєднатись, подивитись стан.
 *
 * Імʼя людини береться з того, що вона сама написала при вступі, а не з
 * Telegram-профілю: у колі рідних «@vasya_2007» нічого не каже, а «Мама» —
 * каже все. І це єдине, що коло взагалі про людину зберігає.
 */
async function circleCommand(
  chatId: number,
  args: string,
  now: number,
): Promise<{ text: string; keyboard?: unknown }> {
  const { sub } = await ensureSubscriber(chatId, new Date().toISOString());
  const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const tail = rest.join(" ").trim();

  if (verb === "нова" || verb === "new" || verb === "створити") {
    const name = tail || "Моє коло";
    if (sub.circle) await leaveCircle(sub.circle, chatId);
    const circle = await createCircle(name, chatId, makeCircleCode);
    await putSubscriber({ ...sub, circle: circle.code, displayName: sub.displayName ?? "Я" }, true);
    return { text: (await circleView({ ...sub, circle: circle.code }, now)) ?? renderCircleHelp() };
  }

  if (verb === "код" || verb === "join" || verb === "приєднатись") {
    const code = normalizeCircleCode(tail);
    if (!code)
      return { text: "Код кола — шість літер і цифр. Приклад: <code>/circle код ABC234</code>" };
    if (sub.circle && sub.circle !== code) await leaveCircle(sub.circle, chatId);
    const circle = await joinCircle(code, chatId);
    if (!circle) return { text: "Такого коду немає. Перепитайте того, хто створив коло." };
    const name = sub.displayName ?? "Учасник";
    await putSubscriber({ ...sub, circle: circle.code, displayName: name }, true);
    return {
      text:
        `✅ Ви в колі <b>${escapeHtml(circle.name)}</b>.\n\n` +
        "Підпишіться, щоб вас упізнавали: <code>/circle імʼя Мама</code>",
    };
  }

  if (verb === "імʼя" || verb === "имя" || verb === "name" || verb === "ім'я") {
    if (!tail) return { text: "Напишіть, як вас підписати: <code>/circle імʼя Мама</code>" };
    await putSubscriber({ ...sub, displayName: tail.slice(0, 40) }, true);
    return { text: `Записано: <b>${escapeHtml(tail.slice(0, 40))}</b>` };
  }

  const view = await circleView(sub, now);
  return { text: view ?? renderCircleHelp() };
}

/**
 * Команди за гейтом.
 *
 * `/stop` тут НЕМАЄ і бути не може (запобіжник 2 у gate.ts), як і `/help`,
 * `/status`, `/start` — людина має спершу зрозуміти, про що взагалі мова.
 * `/start` показує гейт окремо, коли доходить до прохання точки.
 */
const GATED_COMMANDS = new Set([
  "my",
  "radar",
  "me",
  "settings",
  "налаштування",
  "circle",
  "коло",
  "invite",
]);

/**
 * Клавіатура прохання точки.
 *
 * ІНЛАЙН, а не reply з `request_location`. Причина в тому, що reply-кнопка
 * запиту місця показується на всіх клієнтах, але на компʼютері натискання не
 * робить нічого — джерела координат там немає. Єдина видима кнопка, яка на
 * половині пристроїв мовчки не працює, — це не «менш зручно», це глухий кут.
 *
 * Тому основним шляхом стали області (працюють скрізь, без дозволів), а запит
 * геолокації сховано за кнопкою «Точніше»: хто її натисне, отримає окремим
 * повідомленням reply-клавіатуру — там, де вона взагалі щось робить.
 */
function askPointKeyboard(): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return oblastKeyboard(0, [preciseButton()]);
}

/** Натискання кнопок вибору області. `false` — кнопка не наша. */
async function handlePickerPress(
  token: string,
  press: NonNullable<ReturnType<typeof parseCallback>>,
): Promise<boolean> {
  const action = parsePickerAction(press.data);
  if (!action) return false;
  const gate = await subscriptionGate(token, press.userId);
  if (gate) {
    await telegramAnswerCallback(token, press.callbackId, "Спершу підпишіться на канал");
    await telegramSend(token, press.chatId, gate.text, gate.keyboard);
    return true;
  }
  if (press.chatId < 0) {
    await telegramAnswerCallback(token, press.callbackId, "Радар працює в особистому чаті");
    return true;
  }

  if (action.kind === "page") {
    await telegramAnswerCallback(token, press.callbackId, "");
    await telegramEditMessage(
      token,
      press.chatId,
      press.messageId,
      renderAskPoint(),
      oblastKeyboard(action.page, [preciseButton()]),
    );
    return true;
  }

  const { oblast } = action;
  await telegramAnswerCallback(token, press.callbackId, oblast.name);
  await telegramEditMessage(token, press.chatId, press.messageId, renderOblastPicked(oblast.name));
  await savePoint(token, press.chatId, oblast.lat, oblast.lon, `${oblast.name} (центр області)`);
  return true;
}

/**
 * Надіслати перелік укриттів навколо точки.
 *
 * Джерело може не відповісти, і тоді мовчання — найгірше з можливого: людина
 * натиснула «куди сховатися» й не отримала нічого. Тому поразка теж говорить,
 * і говорить корисне — універсальна порада працює без жодних даних.
 */
async function sendShelters(
  token: string,
  chatId: number,
  point: { lat: number; lon: number },
): Promise<void> {
  try {
    // Динамічний імпорт, як і для решти даних інфраструктури: модуль тягне за
    // собою чимало, а вебхук має лишатися легким, поки цього не попросили.
    const { fetchShelters } = await import("./lib/infra.functions");
    const payload = await fetchShelters(point.lat, point.lon);
    const near = nearestShelters(point, payload.shelters, { limit: 4 });

    // Безпечний бік: якщо на точку зараз ІДЕ ціль, мʼяко позначимо укриття, що
    // НЕ в її бік. Порядок за відстанню лишається — це підказка, не наказ. Збій
    // тут не має позбавити людину переліку укриттів, тому все у власному catch.
    let safeNotes: Record<string, string> | undefined;
    try {
      const threats = await fetchThreatsCached(60_000);
      const assess = personalAssessment(threats, point, { radiusKm: 150 });
      const lead = assess.nearest.find((n) => n.inbound);
      if (lead) {
        safeNotes = {};
        for (const m of rankBySafeSide(point, near, lead.bearingToThreat)) {
          if (m.note && m.side !== "flank") safeNotes[m.item.id] = m.note;
        }
      }
    } catch {
      /* безпечний бік — необовʼязковий; перелік укриттів важливіший */
    }

    await telegramSend(
      token,
      chatId,
      renderShelters(near, payload.caveat, payload.degraded, safeNotes),
    );
  } catch {
    await telegramSend(token, chatId, renderShelters([], COVERAGE_CAVEAT, true));
  }
}

/** Натискання кнопок персонального радара. `false` — кнопка не наша. */
async function handlePersonalPress(
  token: string,
  press: NonNullable<ReturnType<typeof parseCallback>>,
): Promise<boolean> {
  const action = parsePersonalAction(press.data);
  if (!action) return false;
  // Поза гейтом: пауза сповіщень (як `/stop`) і дорога до укриття. Ставити
  // умову між людиною під тривогою й укриттям не можна — див. команду
  // `/shelter` нижче в цьому файлі.
  if (action.kind !== "mute" && action.kind !== "shelter" && action.kind !== "share") {
    const gate = await subscriptionGate(token, press.userId);
    if (gate) {
      await telegramAnswerCallback(token, press.callbackId, "Спершу підпишіться на канал");
      await telegramSend(token, press.chatId, gate.text, gate.keyboard);
      return true;
    }
  }
  // Кнопки радара можуть доїхати в групу разом із пересланим повідомленням —
  // і там `press.chatId` уже не людина. Підписника з цього не робимо.
  if (press.chatId < 0) {
    await telegramAnswerCallback(token, press.callbackId, "Радар працює в особистому чаті");
    return true;
  }

  const { sub } = await ensureSubscriber(press.chatId, new Date().toISOString());

  // «Точніше» — окремим повідомленням, бо reply-клавіатуру з запитом місця
  // НЕМОЖЛИВО вкласти в редагування: Telegram приймає там лише inline-кнопки.
  if (action.kind === "wantGeo") {
    await telegramAnswerCallback(token, press.callbackId, "Надішліть геолокацію");
    await telegramSend(
      token,
      press.chatId,
      [
        "📍 <b>Точна точка</b>",
        "",
        "📱 <b>Телефон</b> — кнопка «Надіслати мою точку» внизу екрана.",
        "💻 <b>Компʼютер</b> — кнопка внизу там не працює (джерела координат немає). Зробіть так: 📎 → <b>Локація</b> → вибрати точку на карті → надіслати.",
        "",
        "<i>Можна надіслати й живу геолокацію — тоді точка їхатиме за вами.</i>",
      ].join("\n"),
      locationKeyboard("private"),
    );
    return true;
  }

  // Меню «що чути» — окремою гілкою: воно лише перемальовує клавіатуру.
  if (action.kind === "soundMenu") {
    await telegramAnswerCallback(token, press.callbackId, "Що саме чути?");
    await telegramEditMessage(
      token,
      press.chatId,
      press.messageId,
      "👂 <b>Що чути у вас зараз?</b>\n\n<i>Один доклад нічого не піднімає — " +
        "потрібен збіг кількох людей поруч. Саме тому це працює.</i>",
      soundKeyboard(),
    );
    return true;
  }

  if (action.kind === "sound") {
    const now = Date.now();
    if (!sub.point) {
      await telegramAnswerCallback(token, press.callbackId, "Спершу задайте точку: /my");
      return true;
    }
    if (!canReport(sub.lastSoundAt ?? undefined, now)) {
      await telegramAnswerCallback(token, press.callbackId, "Щойно записали ваш доклад");
      return true;
    }
    recordSound({ chatId: press.chatId, ...sub.point, kind: action.value, at: now });
    await putSubscriber({ ...sub, lastSoundAt: now });
    const clusters = corroborate(soundReports, sub.point, now);
    await telegramAnswerCallback(token, press.callbackId, "Дякуємо, записано");
    await telegramSend(token, press.chatId, renderReportAccepted(action.value, clusters));
    const card = await personalCard({ ...sub, lastSoundAt: now });
    if (card) {
      await telegramEditMessage(token, press.chatId, press.messageId, card.text, card.keyboard);
    }
    return true;
  }

  /*
   * «Куди сховатися». Окремим повідомленням, а не редагуванням картки:
   * людина під тривогою має тримати обидва — і обстановку, і дорогу, — а
   * редагування з'їло б перше заради другого.
   */
  if (action.kind === "shelter") {
    if (!sub.point) {
      await telegramAnswerCallback(token, press.callbackId, "Спершу вкажіть точку");
      await telegramSend(token, press.chatId, renderAskPoint(), askPointKeyboard());
      return true;
    }
    await telegramAnswerCallback(token, press.callbackId, "Шукаю поруч…");
    await sendShelters(token, press.chatId, sub.point);
    return true;
  }

  /*
   * «Поділитися обстановкою» — знеособлена картка для пересилання рідним.
   *
   * Окремим повідомленням і БЕЗ клавіатури: карту пересилають далі, а inline-
   * кнопки з чужим callback у чужому чаті працювати не будуть. Замість них у
   * тексті — deep-link на бота: хто отримав картку, одним дотиком заведе свою
   * точку. Показуємо назву точки (місто/область), а не координати.
   */
  if (action.kind === "share") {
    if (!sub.point) {
      await telegramAnswerCallback(token, press.callbackId, "Спершу вкажіть точку");
      await telegramSend(token, press.chatId, renderAskPoint(), askPointKeyboard());
      return true;
    }
    await telegramAnswerCallback(token, press.callbackId, "Готую картку…");
    const threats = await fetchThreatsCached(60_000);
    const assess = personalAssessment(threats, sub.point, { radiusKm: sub.radiusKm });
    const danger = dangerIndex(assess);
    const name = await botUsername(token);
    const botLink = name ? `https://t.me/${name}?start=sh` : undefined;
    await telegramSend(
      token,
      press.chatId,
      renderShareCard({ placeLabel: sub.point.label, assessment: assess, danger, botLink }),
    );
    return true;
  }

  if (action.kind === "imOk") {
    const now = Date.now();
    await putSubscriber({ ...sub, okAt: now });
    await telegramAnswerCallback(token, press.callbackId, "Передали вашим");
    await broadcastOk(token, { ...sub, okAt: now });
    return true;
  }

  let updated = sub;
  let toast = "Оновлено";

  if (action.kind === "tier") {
    updated = { ...sub, tier: action.value };
    toast = "Поріг збережено";
  } else if (action.kind === "night") {
    updated = { ...sub, night: action.value };
    toast = "Нічний режим збережено";
  } else if (action.kind === "radius") {
    updated = { ...sub, radiusKm: clampRadius(action.value) };
    toast = `Радіус: ${updated.radiusKm} км`;
  } else if (action.kind === "lead") {
    updated = { ...sub, leadMin: action.value == null ? null : clampLead(action.value) };
    toast =
      updated.leadMin == null ? "Поріг часу: за радіусом" : `Будити за ≤${updated.leadMin} хв`;
  } else if (action.kind === "mute") {
    updated = { ...sub, muted: action.value };
    toast = action.value ? "Сповіщення на паузі" : "Сповіщення увімкнені";
  }

  if (updated !== sub) await putSubscriber(updated);
  await telegramAnswerCallback(token, press.callbackId, toast);

  if (action.kind === "refresh") {
    const card = await personalCard(updated);
    if (!card) {
      // Точки ще немає. Вибір області — inline, тож його МОЖНА вкласти в
      // редагування: саме тому він і став основним шляхом.
      await telegramEditMessage(
        token,
        press.chatId,
        press.messageId,
        renderAskPoint(),
        askPointKeyboard(),
      );
      return true;
    }
    await telegramEditMessage(token, press.chatId, press.messageId, card.text, card.keyboard);
    return true;
  }

  await telegramEditMessage(
    token,
    press.chatId,
    press.messageId,
    renderSettings(updated),
    settingsKeyboard(updated),
  );
  return true;
}

/**
 * Точка за назвою: місто, якщо знаємо, інакше центр області.
 *
 * Порядок саме такий: мешканцю Кременчука центр Полтавщини дає радіус від
 * чужого міста, і це рівно та неточність, яку люди помічають першою.
 */
async function findPlacePoint(query: string): Promise<RoutePoint | null> {
  // `matchPlace` уже вміє обидва рівні: спершу місто, далі центр області.
  // Власне падіння на область тут було б другим способом робити те саме.
  const { matchPlace } = await import("./lib/places");
  const found = matchPlace(query);
  if (!found) return null;
  return {
    lat: found.lat,
    lon: found.lon,
    label: found.kind === "oblast" ? `${found.name} (центр області)` : found.name,
  };
}

/**
 * Головне місце дублюється в `point`.
 *
 * Не заради сумісності заради сумісності: увесь код, що вміє «точку людини»,
 * працює без змін, і його не треба переписувати заради нової можливості.
 */
function syncPrimary(sub: Subscriber): Subscriber {
  const main = primaryPlace(sub.places ?? []);
  if (!main) return sub;
  return {
    ...sub,
    point: { lat: main.lat, lon: main.lon, label: main.label },
    radiusKm: placeRadiusKm(main, sub.radiusKm),
  };
}

/** Звіт по дорозі: обстановка в кожній області маршруту. */
async function routeReport(from: RoutePoint, to: RoutePoint): Promise<string> {
  const threats = await fetchThreatsCached(60_000);
  const active = (await fetchOfficialAlerts()) ?? [];
  const report = buildRoute(from, to, (p) => {
    const oblast = oblastOf(p.lat, p.lon);
    return {
      oblast,
      threats: threats.filter((t) => distanceKm(t, p) <= 50).length,
      alarm: active.includes(oblast),
    };
  });
  return renderRoute(report);
}

/**
 * Черговий по чату.
 *
 * Умикати може лише адміністратор групи: це спільне сповіщення на двадцять
 * людей, а не особисте налаштування. Той, хто може додати бота в чат, може й
 * вирішувати, чи чат буде будити.
 */
async function dutyCommand(
  parsed: BotCommand,
  userId: number | undefined,
): Promise<{ text: string; keyboard?: unknown }> {
  const { chatId, chatType, args } = parsed;
  if (chatType === "private") {
    return {
      text: [
        "🛡 <b>Черговий по чату</b> — це для груп.",
        "",
        "Додайте бота у свій чат (родина, під'їзд, зміна) і напишіть там <code>/duty Харків</code>.",
        "",
        "<i>Для себе особисто — /my.</i>",
      ].join("\n"),
    };
  }

  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (token && typeof userId === "number" && !(await isChatAdmin(token, chatId, userId))) {
    return { text: "Умикати чергового може лише адміністратор чату." };
  }

  const action = parseDutyArgs(args);
  const existing = await getDuty(chatId);
  if (!action) return { text: existing ? renderDuty(existing) : renderDutyHelp() };

  if (action.kind === "off") {
    await dropDuty(chatId);
    return { text: "🛡 Чергового вимкнено. Цей чат більше не отримує попереджень." };
  }
  if (!existing && action.kind !== "place") {
    return { text: renderDutyHelp() };
  }
  if (action.kind === "radius" && existing) {
    const next = { ...existing, radiusKm: action.km };
    await putDuty(next, true);
    return { text: renderDuty(next) };
  }
  if (action.kind === "level" && existing) {
    const next = { ...existing, level: action.level };
    await putDuty(next, true);
    return { text: renderDuty(next) };
  }
  if (action.kind !== "place") return { text: renderDutyHelp() };

  const found = await findPlacePoint(action.query);
  if (!found) return { text: `Не знайшов «${escapeHtml(action.query)}». Спробуйте назву міста.` };
  const duty = newGroupDuty(
    chatId,
    parsed.chatType,
    { lat: found.lat, lon: found.lon, label: found.label },
    userId ?? 0,
    new Date().toISOString(),
  );
  const next = existing
    ? { ...existing, ...duty, level: existing.level, radiusKm: existing.radiusKm }
    : duty;
  await putDuty(next, true);
  return { text: renderDuty(next) };
}

/** Чи людина адміністратор цього чату. Помилка читається як «ні». */
async function isChatAdmin(token: string, chatId: number, userId: number): Promise<boolean> {
  try {
    const res = await fetch(
      `${TELEGRAM_API}/bot${token}/getChatMember?chat_id=${chatId}&user_id=${userId}`,
    );
    const body = (await res.json()) as { result?: { status?: string } };
    const status = body.result?.status;
    return status === "creator" || status === "administrator";
  } catch {
    return false;
  }
}

/**
 * Обхід чергових по чатах.
 *
 * Окремо від персонального навмисно: у групи інша модель — одна спільна точка,
 * вищий поріг, довша пауза. Злити їх означало б будити двадцять людей за
 * правилами, писаними для одного.
 */
async function groupDutySweep(threats: readonly Threat[], now: number): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return;
  const duties = await allDuties();
  if (duties.length === 0) return;

  const active = (await fetchOfficialAlerts()) ?? [];
  for (const duty of duties) {
    const point = { lat: duty.lat, lon: duty.lon };
    const assess = personalAssessment(threats, point, { radiusKm: duty.radiusKm, motionOf });
    const incoming = assess.nearest
      .filter((n) => n.inbound)
      .map((n) => ({
        id: n.threat.id,
        critical: CRITICAL_TYPES.has(n.threat.type ?? "unknown"),
      }));
    const verdict = shouldNotifyGroup(duty, incoming, now);
    if (!verdict.send) continue;

    const danger = dangerIndex(assess);
    const oblast = oblastOf(duty.lat, duty.lon);
    const text =
      renderAlert(assess, danger, duty.label, { trust: trustLine(assess) }) +
      (active.includes(oblast) ? `\n\n🔴 У ${oblast} триває офіційна тривога.` : "") +
      `\n\n${renderAdvice(worstAdvice(assess.nearest.filter((n) => n.inbound).map((n) => n.threat.type)))}`;
    const res = await telegramSend(token, duty.chatId, text, undefined, true);
    if (res.ok) {
      await putDuty({ ...duty, lastAlertAt: now, lastAlertIds: verdict.ids });
    } else if (res.status === 403) {
      // Бота видалили з чату — чергового більше нема кому нести.
      await dropDuty(duty.chatId);
    }
    await new Promise((r) => setTimeout(r, ALERT_SEND_GAP_MS));
  }
}

/* ─── Офіційна тривога для моєї області ─────────────────────────────────── */

/**
 * Найпростіше, чого бот не вмів найдовше.
 *
 * Радар рахував траєкторії, промахи й шанси — і жодного разу не казав людині
 * того, заради чого вмикають будь-який інший бот: «у вашій області оголошено
 * тривогу». Подію ми бачили щохвилини й використовували для відбою в каналі, а
 * до того, кого вона стосується, не доносили.
 *
 * `null` на старті — не «тривог немає», а «ми ще не знаємо». Без цієї різниці
 * кожен редеплой розсилав би «оголошено тривогу» всім, у кого вона вже тривала
 * годину, тобто перетворювався б на хибну сирену.
 */
let knownAlerts: string[] | null = null;
let alertStarts = new Map<string, number>();

async function officialAlertSweep(): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return;
  const active = await fetchOfficialAlerts();
  if (active === null) return; // джерело мовчить — станів не вигадуємо

  const now = Date.now();
  const transitions = oblastTransitions(knownAlerts, active);
  const startsBefore = alertStarts;
  knownAlerts = [...active];
  alertStarts = updateAlertStarts(alertStarts, active, now);
  if (transitions.length === 0) return;

  const subs = await allSubscribers();
  const queue: Envelope<{ chatId: number; text: string; stats: StatsHook | null }>[] = [];

  // Коло рідних: хто за ким стежить і в яких вони областях.
  const circleMembers = new Map<string, { chatId: number; name: string; oblasts: string[] }[]>();
  for (const sub of subs) {
    const oblasts = [
      ...new Set(placesFromLegacy(sub.point, sub.places, now).map((p) => oblastOf(p.lat, p.lon))),
    ];
    if (sub.circle) {
      const list = circleMembers.get(sub.circle) ?? [];
      list.push({ chatId: sub.chatId, name: sub.displayName ?? "Хтось", oblasts });
      circleMembers.set(sub.circle, list);
    }
  }

  for (const t of transitions) {
    for (const sub of subs) {
      if (sub.muted || sub.officialAlerts === false) continue;
      const mine = placesFromLegacy(sub.point, sub.places, now).filter(
        (p) => oblastOf(p.lat, p.lon) === t.oblast,
      );
      if (mine.length === 0) continue;
      const text =
        t.kind === "started"
          ? renderAlertStarted(
              t.oblast,
              mine.map((p) => p.label),
            )
          : renderAlertCleared(
              t.oblast,
              startsBefore.has(t.oblast) ? formatDuration(now - startsBefore.get(t.oblast)!) : null,
            );
      queue.push({
        chatId: sub.chatId,
        // Офіційна тривога — факт, а не оцінка: вона йде поперед наших
        // попереджень. Відбій терпить: помилитись у бік спокою не можна,
        // але й поспішати з ним нікуди.
        priority: t.kind === "started" ? Priority.Shelter : Priority.Routine,
        expiresAt: now + USEFUL_WINDOW_MS,
        payload: {
          chatId: sub.chatId,
          text,
          /*
           * Статистика пишеться лише за фактом ДОСТАВКИ: порахувати тривогу
           * тій, кому повідомлення не дійшло, означало б показати їй у
           * підсумку місяця чужий місяць.
           */
          stats:
            t.kind === "started"
              ? { sub, kind: "started" as const, minutes: 0 }
              : startsBefore.has(t.oblast)
                ? {
                    sub,
                    kind: "cleared" as const,
                    minutes: (now - startsBefore.get(t.oblast)!) / 60_000,
                  }
                : null,
        },
      });
    }

    // «У мами тривога» — те, через що люди насправді не сплять.
    for (const [, members] of circleMembers) {
      for (const target of circleAlertTargets(members, t.oblast)) {
        queue.push({
          chatId: target.chatId,
          priority: Priority.Watch,
          expiresAt: now + USEFUL_WINDOW_MS,
          payload: {
            chatId: target.chatId,
            text:
              t.kind === "started"
                ? renderRelativeAlarm([target.aboutName], t.oblast)
                : renderRelativeClear([target.aboutName], t.oblast),
            // Тривога в чужій області — не подія власного місяця людини.
            stats: null,
          },
        });
      }
    }
  }

  await deliver(
    queue,
    async (envelope) => {
      const res = await telegramSend(
        token,
        envelope.chatId,
        envelope.payload.text,
        undefined,
        true,
      );
      const hook = envelope.payload.stats;
      if (res.ok && hook) {
        /*
         * Тривалість пишеться за фактом ВІДБОЮ, а сама тривога — за фактом
         * початку. Рахувати «скільки вже триває» щотика означало б записати ту
         * саму тривогу десятки разів; чекати відбою, щоб її порахувати, —
         * втратити ті, що тривають досі.
         *
         * Читаємо підписника свіжим: черга розтягнута в часі, і за цей час
         * людину могло зачепити власне попередження.
         */
        const fresh = (await getSubscriber(hook.sub.chatId)) ?? hook.sub;
        await putSubscriber({
          ...fresh,
          stats:
            hook.kind === "started"
              ? recordAlarmStart(fresh.stats, now)
              : recordAlarmMinutes(fresh.stats, hook.minutes, hook.minutes, now),
        });
      }
      return {
        ok: res.ok,
        status: res.status,
        ...(res.retryAfterSec !== undefined ? { retryAfterSec: res.retryAfterSec } : {}),
      };
    },
    { windowMs: ALERT_TICK_EVERY_MS },
  );
}

interface StatsHook {
  sub: Subscriber;
  /** `started` — рахуємо саму тривогу; `cleared` — її тривалість. */
  kind: "started" | "cleared";
  minutes: number;
}

/* ─── Зліт носіїв: попередження за десять хвилин до пізно ───────────────── */

/**
 * Найцінніші хвилини в усій системі.
 *
 * Балістику неможливо попередити після пуску — вона долає країну швидше, ніж
 * ми встигаємо когось повідомити. Але в пуску є попередник: зліт носія. Ці
 * повідомлення ми вже отримували й розчиняли в переліку цілей як «✈️ 1 борт» —
 * тобто найважливіше виглядало як найменш важливе.
 */
let lastCarrier: CarrierWarning | null = null;

async function carrierSweep(threats: readonly Threat[], now: number): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return;
  const found = detectCarrier(threats, now);
  if (!found) return;
  // Одне попередження на зліт, а не на кожен тик: повторюване «готовність»
  // перестає бути попередженням швидше за все інше.
  if (warningIsFresh(lastCarrier, now)) return;
  lastCarrier = found;

  const text = renderCarrierWarning(found);
  const subs = (await allSubscribers()).filter(
    (s) => !s.muted && placesFromLegacy(s.point, s.places, Date.now()).length > 0,
  );
  const queue: Envelope<{ chatId: number }>[] = subs.map((sub) => ({
    chatId: sub.chatId,
    priority: Priority.Attention,
    expiresAt: now + USEFUL_WINDOW_MS,
    payload: { chatId: sub.chatId },
  }));

  await deliver(
    queue,
    async (envelope) => {
      const res = await telegramSend(token, envelope.chatId, text, undefined, true);
      return {
        ok: res.ok,
        status: res.status,
        ...(res.retryAfterSec !== undefined ? { retryAfterSec: res.retryAfterSec } : {}),
      };
    },
    { windowMs: ALERT_TICK_EVERY_MS },
  );

  const channel = process.env["TELEGRAM_CHANNEL_ID"];
  if (channel) await sendChannelUpdate(token, channel, text, 0, null, await channelButtons(token));
}

/* ─── Сповіщення: бот пише сам, коли на точку йде ціль ──────────────────── */

/**
 * Ритм сповіщень.
 *
 * Пʼятихвилинний крок каналу тут не годиться: шахед за пʼять хвилин проходить
 * пʼятнадцять кілометрів, тобто третину усталеного радіуса — людина отримала б
 * сповіщення тоді, коли воно вже не потрібне. Півтори хвилини — компроміс між
 * цим і навантаженням на джерело, яке нам нічого не винне.
 */
const ALERT_TICK_EVERY_MS = 90 * 1000;
/** Пауза між надсиланнями: Telegram приймає до 30 повідомлень на секунду. */
const ALERT_SEND_GAP_MS = 40;
/** Скільки передтривога чекає на сирену, перш ніж перестати рахуватись. */
const PRE_ALERT_TTL_MS = 60 * 60 * 1000;

let alertTimer: ReturnType<typeof setInterval> | null = null;
let alertSweepRunning = false;

export interface AlertSweepResult {
  checked: number;
  sent: number;
  skipped: number;
}

/**
 * Один обхід підписників.
 *
 * Рішення «будити чи ні» ухвалює `decideAlert` — чиста функція з тестами. Тут
 * лише мережа й облік: це навмисно, бо саме сюди найлегше було б протягнути
 * «ну надішлемо про всяк випадок», яке й убиває такі боти.
 */
/** Що саме несе конверт черги — щоб надсилач знав, кому й що записати після. */
interface AlertPayload {
  sub: Subscriber;
  text: string;
  keyboard: unknown;
  /** `null` — це сповіщення про ЧУЖЕ місце, і власний стан людини воно не чіпає. */
  decision: ReturnType<typeof decideAlert> | null;
  pre: boolean;
  oblast: string;
  /** Заповнене лише для другорядних місць — тоді записуємо кулдаун по місцю. */
  place?: MyPlace;
}

const LEVEL_PRIORITY: Record<string, Priority> = {
  shelter: Priority.Shelter,
  attention: Priority.Attention,
  watch: Priority.Watch,
  calm: Priority.Routine,
};

/**
 * Кого взагалі має сенс обраховувати цього такту.
 *
 * Раніше — усіх. Для кожного підписника рахувалась відстань до кожної цілі,
 * тобто O(підписники × цілі), і майже вся ця робота була наперед марною: наліт
 * стоїть над кількома областями, а решта країни до нього стосунку не має.
 *
 * Тепер питання перевернуте: не «які цілі поруч із людиною», а «хто поруч із
 * ціллю». Підписники розкладаються по просторовій сітці РІВНЯМИ РАДІУСА — той,
 * хто просив 25 км, і не має перевірятись на сотні.
 *
 * Заміряно (рівномірні підписники по містах, хвиля над двома областями,
 * 18 цілей): 1 000 000 підписників — повний перебір 593 мс проти 229 мс з
 * індексом плюс 179 мс на побудову; кандидатів 188 831 замість 1 000 000, і
 * знайдено рівно тих самих 65 169. Тест звіряє збіг із повним перебором.
 *
 * Межа названа прямо: коли цілі стоять по всій країні, відсіювати нема чого, і
 * індекс лише додає роботи. Але в цьому випадку вузьке місце вже не процесор —
 * мільйон сповіщень на документованих 30/с це дев'ять годин, тобто на три
 * порядки більше за будь-яку економію тут.
 */
function alertCandidates(subs: readonly Subscriber[], threats: readonly Threat[]): Subscriber[] {
  if (threats.length === 0) return [];

  const byRadius = new Map<number, (Subscriber & { lat: number; lon: number })[]>();
  for (const sub of subs) {
    if (!sub.point) continue;
    const flat = { ...sub, lat: sub.point.lat, lon: sub.point.lon };
    const bucket = byRadius.get(sub.radiusKm);
    if (bucket) bucket.push(flat);
    else byRadius.set(sub.radiusKm, [flat]);
  }

  const seen = new Set<number>();
  const out: Subscriber[] = [];
  for (const [radiusKm, group] of byRadius) {
    const index = buildGeoIndex(group, 50);
    for (const cand of candidatesFor(index, threats, radiusKm, (x) => x.chatId)) {
      if (seen.has(cand.chatId)) continue;
      seen.add(cand.chatId);
      out.push(cand);
    }
  }
  return out;
}

/**
 * Один обхід підписників.
 *
 * Дві архітектурні речі, яких тут не було:
 *
 * 1. **Відбір кандидатів** (вище) — щоб обхід не ріс від тих, кого наліт не
 *    стосується.
 * 2. **Черга з пріоритетом і строком** замість циклу з паузами. Telegram
 *    документує ~30 повідомлень/с; коли попередити треба більше людей, ніж
 *    дозволено, порядок вирішує, хто отримає попередження вчасно. Раніше цей
 *    порядок задавався тим, як підписники лежали у файлі, а решта мовчки
 *    відкидалась глухим лічильником «не більше 400 за обхід».
 *
 * Рішення «будити чи ні» лишається там, де було, — у чистій `decideAlert`.
 */
async function personalAlertSweep(): Promise<AlertSweepResult> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const empty: AlertSweepResult = { checked: 0, sent: 0, skipped: 0 };
  if (!token) return empty;

  const subs = (await allSubscribers()).filter((s) => s.point && !s.muted);
  if (subs.length === 0) return empty;

  const threats = await fetchThreatsCached(60_000);
  const official = await fetchOfficialAlerts();
  const now = Date.now();
  const hour = kyivHour(new Date(now));
  // Зліт носія попереджає про те, що після пуску попередити вже не встигнемо.
  await carrierSweep(threats, now);
  await groupDutySweep(threats, now);

  // Кандидати за близькістю — плюс ті, у кого лишився стан із минулого разу
  // (надіслана передтривога, перелік уже оголошених цілей). Їх мало, і без них
  // прострочена передтривога висіла б вічно, а історія сповіщень не старіла б.
  const nearThreats = alertCandidates(subs, threats);
  const nearIds = new Set(nearThreats.map((s) => s.chatId));
  const stateful = subs.filter(
    (s) => !nearIds.has(s.chatId) && (s.preAlert || s.lastAlertIds.length > 0),
  );
  const considered = [...nearThreats, ...stateful];

  const queue: Envelope<AlertPayload>[] = [];

  for (const raw of considered) {
    const sub = forgetStale(raw, now);
    const point = sub.point;
    if (!point) continue;

    const oblast = oblastOf(point.lat, point.lon);
    const phase = alertPhase(official, oblast);

    // Передтривога, за якою сирена так і не пролунала, застаріває. Інакше
    // через півдня перша-ліпша офіційна тривога зарахувалась би як «ми
    // попередили» — звіт про випередження, якого не було.
    if (sub.preAlert && now - sub.preAlert.at > PRE_ALERT_TTL_MS) {
      await putSubscriber({ ...sub, preAlert: null });
      continue;
    }

    // Офіційну оголосили після НАШОЇ передтривоги — кажемо, на скільки
    // випередили. Це єдине місце, де бот звітує про власну швидкість, і воно
    // звітує заміряним числом, а не обіцянкою.
    if (phase === "official" && sub.preAlert && sub.preAlert.oblast === oblast) {
      const lead = leadMinutes(sub.preAlert.at, now);
      /*
       * Заміряне випередження лягає в особисту статистику ОДРАЗУ, а не після
       * доставки: сам вимір відбувся тут, і втратити його через недоставлене
       * повідомлення означало б занизити власний звіт на користь собі.
       */
      await putSubscriber({ ...sub, stats: recordLead(sub.stats, lead, now) });
      queue.push({
        chatId: sub.chatId,
        priority: Priority.Routine,
        expiresAt: now + USEFUL_WINDOW_MS,
        payload: {
          sub,
          text: renderOfficialConfirmed(oblast, lead),
          keyboard: undefined,
          decision: { send: true, reason: "офіційну оголошено", ids: [], level: "watch" },
          pre: false,
          oblast,
        },
      });
      continue;
    }

    /*
     * Хвилини під тривогою рахуються тут, бо саме тут відома фаза для точки
     * людини. Приріст береться з годинника, а не зі сталого кроку планувальника:
     * тик смикають і зовнішній крон, і рестарти, а стеля в 15 хвилин обрізає
     * прогалину після перезапуску.
     */
    const underAlarm = phase === "official";
    if (underAlarm) {
      const since = sub.alarmSince ?? now;
      const countedAt = sub.alarmCountedAt ?? now;
      const add = Math.min((now - countedAt) / 60_000, 15);
      const run = (now - since) / 60_000;
      await putSubscriber({
        ...sub,
        alarmSince: since,
        alarmCountedAt: now,
        stats: recordAlarmMinutes(sub.stats, add, run, now),
      });
    } else if (sub.alarmSince) {
      /*
       * Тривога скінчилась. Це єдине місце, де можна сказати «можна виходити»,
       * і воно чекає саме на ОФІЦІЙНЕ скасування: `phase` рахується з даних
       * Повітряних Сил, а не з нашої картини неба. Порожньо в OSINT означає
       * лише, що ніхто нічого не бачить.
       */
      const clear = decideAllClear({
        officialActive: false,
        alarmSince: sub.alarmSince,
        // Турбували ми людину за цю тривогу чи ні — видно з часу останнього
        // сповіщення: якщо воно було вже після початку тривоги, значить так.
        wasAlerted: sub.lastAlertAt >= sub.alarmSince,
        now,
      });
      await putSubscriber({ ...sub, alarmSince: null, alarmCountedAt: null });
      if (clear.send) {
        const summary = summarizeMonth(sub.stats, now);
        queue.push({
          chatId: sub.chatId,
          priority: Priority.Routine,
          expiresAt: now + USEFUL_WINDOW_MS,
          payload: {
            sub,
            text: renderPersonalAllClear(clear.durationMin, {
              longestThisMonth: (summary?.longestAlarmMin ?? 0) <= clear.durationMin,
            }),
            keyboard: undefined,
            decision: null,
            pre: false,
            oblast,
          },
        });
      }
      continue;
    }

    const assess = personalAssessment(threats, point, { radiusKm: sub.radiusKm, motionOf });
    const danger = dangerIndex(assess);
    const decision = decideAlert(sub, assess, danger, now, hour);
    if (!decision.send) {
      if (sub !== raw) await putSubscriber(sub);
      continue;
    }

    // Поспішити з попередженням безпечно — поспішити з відбоєм смертельно.
    // Тому сирени ми НЕ чекаємо, але й не вдаємо, що вона вже пролунала.
    const pre = phase === "pre";
    queue.push({
      chatId: sub.chatId,
      priority: LEVEL_PRIORITY[danger.level] ?? Priority.Watch,
      // Строк придатності — не стільки, скільки не шкода чекати, а стільки,
      // скільки попередження ще щось означає.
      expiresAt: now + USEFUL_WINDOW_MS,
      payload: {
        sub,
        // «Що робити» — лише в найгострішому сповіщенні. Інструкція під кожним
        // «пильнуйте» перетворилась би на підпис, який перестають читати саме
        // тоді, коли вона єдина має значення.
        text:
          renderAlert(assess, danger, point.label, { pre, trust: trustLine(assess) }) +
          (danger.level === "shelter"
            ? `\n\n${renderAdvice(worstAdvice(assess.nearest.filter((n) => n.inbound).map((n) => n.threat.type)))}`
            : ""),
        keyboard: personalKeyboard(
          danger.level === "shelter" && sub.circle ? { withOk: true } : {},
        ),
        decision,
        pre,
        oblast,
      },
    });
  }

  /*
   * Другорядні місця — окремим проходом і за суворішим правилом.
   *
   * Про власну точку людина може діяти на будь-якому рівні. Про дім батьків за
   * триста кілометрів вона не може зробити нічого, крім як хвилюватись, тож
   * «підвищена готовність» там — чиста тривога без дії. Кажемо лише про
   * серйозне й не частіше разу на двадцять хвилин.
   */
  for (const raw of subs) {
    const places = placesFromLegacy(raw.point, raw.places, now);
    const primary = primaryPlace(places);
    for (const place of places) {
      if (primary && place.title === primary.title) continue; // про себе вже сказали вище
      // Радіус місця, а не людини: навколо дачі поле, навколо дому — місто.
      const pAssess = personalAssessment(threats, place, {
        radiusKm: placeRadiusKm(place, raw.radiusKm),
        motionOf,
      });
      const pDanger = dangerIndex(pAssess);
      const pDecision = decidePlaceAlert(place, pDanger.level, raw.placeAlerts, now);
      if (!pDecision.send) continue;
      queue.push({
        chatId: raw.chatId,
        priority: Priority.Watch,
        expiresAt: now + USEFUL_WINDOW_MS,
        payload: {
          sub: raw,
          text: renderPlaceAlert(place, pDanger.verdict, pDanger.caveat),
          keyboard: undefined,
          decision: null,
          pre: false,
          oblast: oblastOf(place.lat, place.lon),
          place,
        },
      });
    }
  }

  const report = await deliver(
    queue,
    async (envelope) => {
      const { sub, text, keyboard, decision, pre, oblast, place } = envelope.payload;
      const res = await telegramSend(token, sub.chatId, text, keyboard, true);
      if (res.ok) {
        const at = Date.now();
        if (place) {
          /*
           * Сповіщення про ЧУЖЕ місце не чіпає власного стану людини: інакше
           * звістка про Харків зарахувалась би як «ми вже попередили» і
           * з'їла б її власне попередження за кілька хвилин по тому.
           */
          const fresh = (await getSubscriber(sub.chatId)) ?? sub;
          await putSubscriber({
            ...fresh,
            placeAlerts: markPlaceAlerted(fresh.placeAlerts, place, at),
          });
        } else if (decision) {
          const marked = markAlerted(
            {
              ...sub,
              stats: recordAlert(sub.stats, at, { shelter: decision.level === "shelter" }),
            },
            decision,
            at,
          );
          await putSubscriber(pre ? { ...marked, preAlert: { at, oblast } } : marked);
        }
      } else if (res.status === 403) {
        // Бота заблокували або видалили чат. Далі слати — марно витрачати
        // бюджет, потрібний тим, хто чекає.
        await putSubscriber({ ...sub, muted: true });
      }
      return {
        ok: res.ok,
        status: res.status,
        ...(res.retryAfterSec !== undefined ? { retryAfterSec: res.retryAfterSec } : {}),
      };
    },
    { windowMs: ALERT_TICK_EVERY_MS },
  );

  if (report.dropped > 0 || report.expired > 0) {
    // Це не дрібниця в логах, а втрачені попередження. Мовчки не дійти до
    // кінця черги — те саме, що не надіслати, тільки непомічене.
    console.warn(
      `alert sweep: не доставлено ${report.dropped + report.expired}` +
        ` (бюджет ${report.dropped}, прострочено ${report.expired}) із ${queue.length}`,
    );
  }

  return {
    checked: considered.length,
    sent: report.sent,
    skipped: report.dropped + report.expired,
  };
}

function startAlertScheduler(): void {
  if (alertTimer) return;
  if (!process.env["TELEGRAM_BOT_TOKEN"]) return;
  const tick = () => {
    // Перекриття обходів дало б два сповіщення про ту саму ціль: довгий обхід
    // не має запускати наступний поверх себе.
    if (alertSweepRunning) return;
    alertSweepRunning = true;
    Promise.all([personalAlertSweep(), officialAlertSweep()])
      .catch((e) => console.error("alert sweep failed", e))
      .finally(() => {
        alertSweepRunning = false;
      });
  };
  const warmup = setTimeout(tick, 30_000);
  (warmup as unknown as { unref?: () => void }).unref?.();
  alertTimer = setInterval(tick, ALERT_TICK_EVERY_MS);
  (alertTimer as unknown as { unref?: () => void }).unref?.();
}
startAlertScheduler();

/**
 * Самоперевірка сховища при старті.
 *
 * Досі власник дізнавався про ефемерне сховище лише тоді, коли сам питав
 * `/stats` — тобто, як правило, вже після втрати підписників. Мовчазна втрата
 * даних не має бути станом, який треба помітити: якщо після запуску сховище не
 * переживе редеплой або в нього взагалі не пишеться, бот каже це сам, один раз
 * на процес.
 *
 * Один раз — навмисно: попередження, яке повторюється щогодини, перестає бути
 * попередженням. І лише власникові: це службова річ, яку більше нікому не
 * виправити.
 */
async function storageSelfCheck(): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const owner = process.env["TELEGRAM_OWNER_ID"]?.trim();
  if (!token || !owner) return;
  const st = await subscriberStats();
  if (st.durable && st.writable) return; // усе гаразд — мовчимо
  await telegramSend(
    token,
    Number(owner),
    ["⚠️ <b>Сховище підписників</b>", "", ...storageLines(st)].join("\n"),
  );
}

function startStorageSelfCheck(): void {
  // Із затримкою: том Railway монтується при старті контейнера, і перевірка в
  // першу ж мілісекунду могла б застати його ще не змонтованим.
  const timer = setTimeout(() => {
    storageSelfCheck().catch((e) => console.error("storage self-check failed", e));
  }, 45_000);
  (timer as unknown as { unref?: () => void }).unref?.();
}
startStorageSelfCheck();

/* ─── Inline-режим ──────────────────────────────────────────────────────── */

/**
 * Відповідь на inline-запит: жива картка обстановки в будь-який чат.
 *
 * `cache_time` короткий: обстановка змінюється швидше за типовий кеш Telegram,
 * а картка, яку надіслали з учорашніми цілями, гірша за відсутність картки.
 * `is_personal` — бо результат залежить від того, що людина набрала.
 */
async function answerInline(token: string, query: ReturnType<typeof parseInlineQuery>) {
  if (!query) return;
  const threats = await fetchThreatsCached(60_000);
  const link = channelLink((await botUsername(token)) ?? undefined);
  const results = inlineResults(threats, query.query, link);
  const res = await fetch(`${TELEGRAM_API}/bot${token}/answerInlineQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      inline_query_id: query.id,
      results,
      cache_time: 30,
      is_personal: true,
      ...(link ? { button: { text: "Свій радар за адресою", start_parameter: "inl" } } : {}),
    }),
  });
  if (!res.ok) console.error("answerInlineQuery failed", res.status, await res.text());
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

  // Той самий кеш, що вирішує долю відбою в каналі: два різні читання одного
  // джерела означали б, що /status і канал можуть розійтися в тому, чи триває
  // тривога — а саме на цьому питанні тут усе й тримається.
  const official = await fetchOfficialAlerts();
  if (official === null) {
    sources.push({ name: "Тривоги", ok: false });
  } else {
    alarms.push(...official);
    sources.push({ name: "Тривоги", ok: true });
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

/* ─── Резервна копія підписників ────────────────────────────────────────── */

/**
 * Надсилає копію власникові файлом.
 *
 * Файлом, а не текстом: повідомлення обмежене 4096 символами, і на сотні
 * підписників копія в текст просто не влізе — а копія, яка мовчки обрізалась,
 * гірша за її відсутність, бо створює враження, що дані збережені.
 */
async function sendBackup(token: string, ownerId: number): Promise<boolean> {
  const st = await subscriberStats();
  const file = buildBackup(await allSubscribers(), await allCircles(), new Date().toISOString());
  if (file.subscribers.length === 0) return false; // порожню копію слати нема сенсу

  const form = new FormData();
  form.append("chat_id", String(ownerId));
  form.append("caption", renderBackupNote(file, !st.durable));
  form.append("parse_mode", "HTML");
  form.append(
    "document",
    new Blob([JSON.stringify(file)], { type: "application/json" }),
    `subscribers-${kyivDate(new Date())}.json`,
  );
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) console.error("backup failed", res.status, await res.text());
  return res.ok;
}

/**
 * Приймає копію назад.
 *
 * Лише від власника й лише з розібраного файлу: мовчки прийняти чужий JSON як
 * базу підписників — це спосіб втратити її замість відновити.
 */
async function restoreBackup(token: string, doc: ReturnType<typeof parseDocument>): Promise<void> {
  if (!doc) return;
  if (!isOwner(doc.userId, process.env["TELEGRAM_OWNER_ID"])) return;
  try {
    const info = (await fetch(
      `${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(doc.fileId)}`,
    ).then((r) => r.json())) as { result?: { file_path?: string } };
    const path = info.result?.file_path;
    if (!path) {
      await telegramSend(token, doc.chatId, "Не вдалося завантажити файл із Telegram.");
      return;
    }
    const raw = await fetch(`${TELEGRAM_API}/file/bot${token}/${path}`).then((r) => r.text());
    const file = parseBackup(raw);
    if (!file) {
      await telegramSend(token, doc.chatId, "Це не схоже на копію підписників — файл не прийнято.");
      return;
    }
    const live = await allSubscribers();
    const liveCircles = await allCircles();
    const subs = mergeSubscribers(live, file.subscribers);
    const circles = mergeCircles(liveCircles, file.circles);
    await insertMissing(file.subscribers, file.circles);
    await telegramSend(token, doc.chatId, renderRestoreResult(subs, circles));
  } catch (error) {
    console.error("restore failed", error);
    await telegramSend(token, doc.chatId, "Відновлення не вдалося — подробиці в логах сервісу.");
  }
}

/**
 * Щоденна копія — разом із підсумком доби.
 *
 * Окремого розкладу не заводимо: підсумок уже має свою годину й свій захист
 * від повторів, а друга копія того самого механізму означала б другий спосіб
 * помилитись.
 */
let backupSentFor: string | null = null;
/**
 * Тижневий підсумок — єдине, що люди пересилають самі.
 *
 * Канал і сповіщення пересилають рідко: вони про зараз. Підсумок — про неї, і
 * саме тому він працює як запрошення краще за будь-яке запрошення.
 *
 * Понеділок після десятої: у неділю ввечері його не читають, а в середу він
 * уже ні про що.
 */
async function maybeWeeklySummary(token: string, now: number): Promise<void> {
  const at = new Date(now);
  const hour = kyivHour(at);
  const subs = await allSubscribers();
  const queue: Envelope<{ chatId: number; text: string; sub: Subscriber }>[] = [];
  for (const sub of subs) {
    if (sub.muted || !sub.stats) continue;
    if (!weeklyDue(at, sub.weeklySentAt ?? null, hour)) continue;
    const summary = summarizeWeek(sub.stats, now);
    // Порожній підсумок («0 тривог за 0 днів») — це не скромність, а
    // повідомлення без змісту: такого не шлемо взагалі.
    if (!summary || (summary.alerts === 0 && summary.alarms === 0)) continue;
    const text = renderStats(summary);
    queue.push({
      chatId: sub.chatId,
      // Найнижчий пріоритет із можливих: підсумок ніколи не має займати
      // бюджет, потрібний попередженню.
      priority: Priority.Routine,
      expiresAt: now + 6 * 60 * 60 * 1000,
      payload: { chatId: sub.chatId, text, sub },
    });
  }
  if (queue.length === 0) return;

  await deliver(
    queue,
    async (envelope) => {
      const res = await telegramSend(
        token,
        envelope.chatId,
        envelope.payload.text,
        undefined,
        true,
      );
      if (res.ok) {
        await putSubscriber({ ...envelope.payload.sub, weeklySentAt: kyivDate(at) });
      }
      return {
        ok: res.ok,
        status: res.status,
        ...(res.retryAfterSec !== undefined ? { retryAfterSec: res.retryAfterSec } : {}),
      };
    },
    { windowMs: ALERT_TICK_EVERY_MS },
  );
}

async function maybeBackup(token: string, now: number): Promise<void> {
  const owner = process.env["TELEGRAM_OWNER_ID"]?.trim();
  if (!owner) return;
  if (kyivHour(new Date(now)) < DIGEST_HOUR) return;
  // Ефемерне сховище — копію слати НЕ треба: там і бекапити нема чого (підписки
  // й так зникнуть), а дедуп у памʼяті скидається щоізоляту, тож копія летіла б
  // щоразу. Саме це й був спам щогодини.
  if (!subscribersDurable()) return;
  const today = kyivDate(new Date(now));
  if (backupSentFor === today) return; // швидкий шлях у межах одного процесу
  // Стійкий дедуп: позначка на тому бачиться всіма ізолятами/реплiками/після
  // редеплою — на відміну від модульної змінної.
  if ((await readMarker("last-backup")) === today) {
    backupSentFor = today;
    return;
  }
  backupSentFor = today;
  // Пишемо ПЕРЕД надсиланням: якщо два виконання зійшлися, друге побачить
  // позначку й не надішле дубль.
  await writeMarker("last-backup", today);
  await sendBackup(token, Number(owner));
}

/**
 * Стан сховища людською мовою — з конкретним наступним кроком.
 *
 * «Ефемерне» без інструкції — це діагноз без лікування: власник бачить
 * попередження, не знає, що робити, і підписники далі зникають при кожному
 * редеплої. Тому тут не лише що не так, а й що саме натиснути.
 *
 * Окремо показано ЗАМІР запису. Усі попередні висновки про сховище були
 * висновками з наявності змінної: том можна підключити не в ту теку або лише
 * для читання, і конфігурація виглядатиме правильною, поки дані зникають.
 */
function storageLines(st: Awaited<ReturnType<typeof subscriberStats>>): string[] {
  const where = `<code>${escapeHtml(st.path)}</code>`;
  const lines: string[] = [];

  if (!st.durable) {
    lines.push(`⚠️ Сховище: <b>ефемерне</b> — ${where}`, "Підписки зникають при кожному редеплої.");

    // Найважливіший рядок. Том, підключений до сусіднього сервісу, виглядає в
    // списку Railway точно так само, як підключений до цього: він просто
    // стоїть під іншою назвою. Тому кажемо, ДЕ САМЕ зараз працює процес —
    // інакше власник дивиться на створений том і не розуміє, чому не вийшло.
    if (st.railwayService) {
      lines.push(
        "",
        `Цей процес працює в сервісі <b>${escapeHtml(st.railwayService)}</b>` +
          (st.railwayProject ? ` (проєкт <b>${escapeHtml(st.railwayProject)}</b>)` : "") +
          " — і до <b>нього</b> тому не підключено.",
        "Том, підключений до сусіднього сервісу, у списку виглядає так само, але цьому процесу не видний.",
      );
    }

    lines.push(
      "",
      "<b>Як полагодити:</b>",
      "1. у проєкті створіть том (<b>+ New</b> → <b>Volume</b>);",
      `2. коли спитає сервіс — оберіть саме <b>${escapeHtml(st.railwayService ?? "консоль")}</b>;`,
      "3. шлях монтування — <code>/data</code>;",
      "4. дочекайтесь перезапуску.",
      "",
      "Більше нічого робити не треба: Railway сам виставляє <code>RAILWAY_VOLUME_MOUNT_PATH</code>, і бот його підхоплює.",
    );
  } else {
    const from =
      st.source === "RAILWAY_VOLUME_MOUNT_PATH"
        ? "том Railway (визначено автоматично)"
        : st.source === "BOT_DATA_DIR"
          ? "задано <code>BOT_DATA_DIR</code>"
          : "задано <code>PLATFORM_DATA_DIR</code>";
    lines.push(`Сховище: <b>постійний том</b> — ${where}`, `Джерело шляху: ${from}`);
  }

  lines.push(
    st.writable
      ? "Запис: <b>перевірено щойно — працює</b>"
      : `❌ Запис: <b>НЕ ПРАЦЮЄ</b>${st.writeError ? ` — ${escapeHtml(st.writeError)}` : ""}`,
  );
  return lines;
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
    parsed.command !== "channel" &&
    parsed.command !== "stats" &&
    parsed.command !== "backup"
  ) {
    return null;
  }
  if (!ownerOk) return { text: renderNotOwner() };

  // Скільки людей насправді прикриті — і чи переживуть підписки редеплой.
  // Друге важливіше за перше: сховище без постійного тому мовчки втрачає всіх
  // підписників при кожному оновленні, і дізнатись про це треба тут, а не з
  // обваленого лічильника через тиждень.
  if (parsed.command === "backup") {
    const token = process.env["TELEGRAM_BOT_TOKEN"];
    if (!token) return { text: "TELEGRAM_BOT_TOKEN не заданий." };
    const ok = await sendBackup(token, parsed.chatId);
    return {
      text: ok
        ? "💾 Копію надіслано файлом. Збережіть її — після втрати сховища перешліть боту назад, і підписники повернуться."
        : "Копіювати нема чого: підписників поки немає.",
    };
  }

  if (parsed.command === "stats") {
    const st = await subscriberStats();
    // Стан вебхука — прямо тут. Саме через нього бот може мовчати на цілий
    // клас оновлень, не повідомляючи про жодну помилку, і перевіряти це з
    // телефона має бути можна без секрету в адресному рядку.
    const hook = await webhookStatus();
    const updates = hook["allowedUpdates"];
    const missing = Array.isArray(updates)
      ? WEBHOOK_UPDATES.filter((u) => !updates.map(String).includes(u))
      : [];
    return {
      text: [
        "📈 <b>Підписники персонального радара</b>",
        "",
        `Усього: <b>${st.total}</b>`,
        `З точкою: <b>${st.withPoint}</b>`,
        `Отримують сповіщення: <b>${st.active}</b>`,
        "",
        ...storageLines(st),
        "",
        ...renderCapacity(capacityFor(st.active)),
        ...(st.lastError ? ["", `Остання помилка запису: ${escapeHtml(st.lastError)}`] : []),
        "",
        "🔌 <b>Вебхук</b>",
        `Адреса: <code>${escapeHtml(String(hook["url"] ?? "—"))}</code>`,
        `Типи оновлень: <code>${escapeHtml(
          Array.isArray(updates) ? updates.join(", ") : String(updates ?? "усталене Telegram"),
        )}</code>`,
        ...(missing.length
          ? [
              `⚠️ Бракує: <b>${missing.join(", ")}</b> — ці оновлення Telegram НЕ доставляє, і помилки при цьому немає.`,
            ]
          : []),
        `У черзі: ${String(hook["pendingUpdates"] ?? 0)}`,
        ...(hook["lastError"]
          ? [`Остання помилка доставки: ${escapeHtml(String(hook["lastError"]))}`]
          : []),
      ].join("\n"),
    };
  }

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
  // Адреса в самому повідомленні. Вона не таємниця (таємниця — ключ), а бачить
  // це лише власник. Без неї «платформа недоступна» не підказує головного:
  // куди саме консоль стукає. У цьому проєкті поруч живуть два схожі сервіси —
  // діючий і давній, що лишився від злиття репозиторіїв, — і змінна, яка
  // вказує на другий, виглядає так само, як обірваний звʼязок із першим.
  const target = process.env["PLATFORM_API_URL"]?.trim();
  const where = target ? `\n\nЗараз указано: <code>${escapeHtml(target)}</code>` : "";

  if (status === 404) {
    return (
      "Платформа відповіла 404: сервіс platform-api не має цього маршруту — його треба передеплоїти вручну (він не оновлюється автоматично)." +
      where
    );
  }
  if (status === 401 || status === 403)
    return `Платформа відхилила ключ (${status}). Перевірте PLATFORM_API_KEY.${where}`;
  if (status === 0) return `Платформа недоступна: перевірте PLATFORM_API_URL.${where}`;
  return `Платформа відповіла ${status}${error ? `: ${error}` : ""}.${where}`;
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

  // Inline-запит: бот працює в чужому чаті, куди його ніхто не додавав.
  const inline = parseInlineQuery(update);
  if (inline) {
    await answerInline(token, inline);
    return new Response("ok", { status: 200 });
  }

  /*
   * Людина щойно підписалась на канал — і про це ми дізнаємось самі.
   *
   * Це те, чим гейт замикається. Без цього обробника той, хто підписався й
   * просто написав `/my` знову, впирався в той самий екран: перевірка
   * кешується на хвилину, і кеш ще тримав «ні». Людина зробила рівно те, що в
   * неї попросили, і отримала ту саму відмову.
   *
   * Telegram шле `chat_member` лише адміністраторам чату. Якщо бота не
   * зробили адміністратором каналу, оновлення просто не прийде — і все працює
   * як раніше, через кнопку «Я підписався». Тому це підсилення, а не
   * залежність.
   */
  const memberChange = parseChatMember(update);
  if (memberChange) {
    const channel = process.env["TELEGRAM_CHANNEL_ID"]?.trim();
    // Зміни в чужих чатах (групи, куди додали бота) гейта не стосуються.
    const ours =
      channel === String(memberChange.chatId) ||
      (channel?.startsWith("@") ?? false) ||
      channel === undefined;
    if (ours) {
      const { userId, oldStatus, newStatus, newIsMember } = memberChange;
      if (justSubscribed(oldStatus, newStatus, newIsMember)) {
        // Кеш тримав «не підписаний» — прибираємо, інакше наступна команда
        // відмовить людині, яка вже все зробила.
        gateCache.set(userId, { at: Date.now(), ok: true });
        const sub = await getSubscriber(userId);
        // Пишемо лише тим, хто вже приходив до бота: непроханий лист від бота,
        // з яким людина не спілкувалась, — це спам, навіть доброзичливий.
        if (sub) {
          await telegramSend(
            token,
            userId,
            renderAccessOpened(),
            sub.point ? undefined : askPointKeyboard(),
          );
        }
      } else if (justLeft(oldStatus, newStatus, newIsMember)) {
        // Лише скидаємо кеш, щоб наступна перевірка була чесною. Сповіщення
        // тим, кого вже попереджали, НЕ вимикаємо — запобіжник 3 у gate.ts.
        gateCache.delete(userId);
      }
    }
    return new Response("ok", { status: 200 });
  }

  // Натискання кнопки приходить окремим типом оновлення, не повідомленням.
  const press = parseCallback(update);
  if (press) {
    // Наборів кнопок тепер три. Персональні й вибір області перевіряються
    // першими, бо їх тиснуть усі, а адмінські — одна людина.
    if (!(await handleGatePress(token, press))) {
      if (!(await handlePickerPress(token, press))) {
        if (!(await handlePersonalPress(token, press))) await handleAdminPress(token, press);
      }
    }
    return new Response("ok", { status: 200 });
  }

  // Геолокація приходить повідомленням БЕЗ тексту — parseCommand її не бачить.
  const location = parseLocation(update);
  if (location && location.chatType === "private") {
    const gate = await subscriptionGate(token, location.userId);
    if (gate) {
      await telegramSend(token, location.chatId, gate.text, gate.keyboard);
      return new Response("ok", { status: 200 });
    }
    // Провал тут НЕ має лишати людину в тиші: зовнішній catch віддав би 200 і
    // жодного слова, а для неї це виглядає як «поділився точкою — нічого не
    // сталося». Тому будь-яку похибку ловимо тут і кажемо про неї прямо.
    try {
      await savePoint(
        token,
        location.chatId,
        location.lat,
        location.lon,
        `моя точка · ${oblastOf(location.lat, location.lon)}`,
        { livePeriod: location.livePeriod, isUpdate: location.isUpdate },
      );
    } catch (error) {
      console.error("savePoint from location failed", error);
      // Оновлення живої точки шле Telegram щохвилини — на його збій відповідати
      // не варто (завалимо чат), а от разову спробу людини лишати без відповіді
      // не можна.
      if (!location.isUpdate) {
        await telegramSend(
          token,
          location.chatId,
          "Не вдалося зберегти точку зараз. Спробуйте ще раз, або оберіть область кнопками: /my",
          { remove_keyboard: true },
        );
      }
    }
    return new Response("ok", { status: 200 });
  }

  // Файл від власника — це повернення резервної копії підписників.
  const document = parseDocument(update);
  if (document) {
    await restoreBackup(token, document);
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

  // Персональний радар — головне, заради чого бота тримають. Йде першим.
  const personal = await personalCommand(token, parsed, senderId(update));
  if (personal === "handled") return new Response("ok", { status: 200 });
  if (personal) {
    await telegramSend(token, parsed.chatId, personal.text, personal.keyboard);
    return new Response("ok", { status: 200 });
  }

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
      allowed_updates: [...WEBHOOK_UPDATES],
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
      // Видно в /setup і /repair: саме через цей перелік бот може мовчати на
      // цілий клас оновлень, не повідомляючи про жодну помилку.
      allowedUpdates: result["allowed_updates"] ?? "(усталене Telegram)",
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
    const result = (info as { result?: { url?: string; allowed_updates?: unknown } } | null)
      ?.result;
    const current = result?.url ?? "";
    // Команди реєструємо навіть коли вебхук уже на місці: перелік міг
    // зʼявитися (ця функція) вже після того, як вебхук став правильним, тож
    // прив'язувати їх до зміни адреси не можна — інакше /admin так і не
    // зʼявиться в меню на вже налаштованому боті.
    void setBotCommands(token, process.env["TELEGRAM_OWNER_ID"]);
    // Звіряємо НЕ ЛИШЕ адресу, а й перелік типів оновлень. Збіг самої адреси
    // раніше означав «нічого не робимо» — і бот роками лишався підписаним на
    // той набір, з яким його зареєстрували вперше.
    if (current === target && webhookUpdatesOk(result?.allowed_updates)) return;
    await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: target,
        ...(secret ? { secret_token: secret } : {}),
        allowed_updates: [...WEBHOOK_UPDATES],
        // Не скидаємо чергу: сюди ми потрапляємо й тоді, коли адреса вже
        // правильна, а бракує лише типів оновлень. Викинути в цей момент усе,
        // що люди написали, поки сервіс перезапускався, — не полагодити, а
        // додати другу поломку.
      }),
    });
  } catch (error) {
    console.error("ensureWebhook failed", error);
    webhookEnsured = false; // дозволимо спробувати ще раз наступного запиту
  }
}

/**
 * Оболонка сторінки не кешується; хешовані ассети — навічно.
 *
 * Це виправлення того, через що задеплоєні зміни не доходили до людей.
 *
 * Ассети мають у назві хеш вмісту й віддаються як `immutable` на рік — це
 * правильно. Але HTML-оболонка, яка й каже, ЯКІ саме хеші вантажити, не мала
 * жодного заголовка кешування взагалі. Без директиви кеш застосовує власну
 * евристику й може тримати документ годинами: WebView Telegram відкриває стару
 * оболонку, та просить старі хеші, а вони `immutable` — тобто віддаються з
 * кешу назавжди. Людина бачить стару збірку нескінченно, хоч на сервері лежить
 * нова, і жоден редеплой цього не лікує.
 *
 * `no-cache` тут означає не «не зберігати», а «перепитати перед показом»: копія
 * лишається, але звіряється з сервером, і `304` віддається дешево. Саме це й
 * потрібно для документа, який важить десятки кілобайт і змінюється з кожним
 * деплоєм.
 */
function withShellCacheHeaders(response: Response): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return response;
  // Заголовок уже виставлений вище за течією — не перебиваємо чужого рішення.
  if (response.headers.has("cache-control")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, must-revalidate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

    // Публічний знімок повітряної обстановки — щоб радар вбудовували інші.
    // Відкритий, з CORS: дані ті самі, що на публічній мапі.
    if (pathname === "/api/air/snapshot") {
      try {
        return await airSnapshotResponse();
      } catch (error) {
        console.error(error);
        return json({ error: "internal error" }, 500);
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
      return withShellCacheHeaders(await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
