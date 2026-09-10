import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { baseReport, probe, type SourceProbe } from "./lib/health";
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

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // Перехоплюється до маршрутизатора: службова відповідь не має залежати
    // від того, чи зібрався застосунок.
    if (new URL(request.url).pathname === "/api/health") {
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
