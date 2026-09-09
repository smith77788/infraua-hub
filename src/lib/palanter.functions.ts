import { createServerFn } from "@tanstack/react-start";

import type { Facility, GraphEdge, InfraEvent } from "./infra-types";
import { isObserved, type Provenance } from "./provenance";

/**
 * Передача картини InfraUA у платформу Palanter.
 *
 * Це друга половина обʼєднання двох частин продукту. Консоль будує граф
 * залежностей у браузері й губить його при перезавантаженні: жодного
 * підтвердження онтологією, жодного рівня доступу, жодного запису в журнал
 * аудиту. Платформа вміє все це — але доти, доки їй нічого не надсилали, вони
 * лишалися двома системами з однаковими намірами.
 *
 * ## Ключ не потрапляє в браузер
 *
 * Це серверна функція навмисно. Palanter автентифікує запити bearer-ключем;
 * якби виклик ішов із браузера, ключ довелося б покласти у клієнтський бандл,
 * тобто віддати кожному відвідувачу. `PALANTER_API_KEY` і `PALANTER_API_URL`
 * читаються тут, на сервері, і клієнт бачить лише результат.
 *
 * ## Незаданий звʼязок — не помилка
 *
 * Консоль повністю самодостатня без Palanter. Якщо змінні не задані,
 * повертається `configured: false`, і це нормальний стан, а не збій.
 */

/** Що саме надсилається — рівно факти, без похідних оцінок. */
interface PalanterDependency {
  from: string;
  to: string;
  km: number;
  kind: string;
  provenance: Provenance;
}

export interface PalanterPushResult {
  /** false — звʼязок із платформою не налаштований, і це не помилка. */
  configured: boolean;
  ok: boolean;
  /** Текст помилки, якщо платформа відповіла відмовою. */
  error?: string;
  facilitiesIngested?: number;
  eventsIngested?: number;
  dependenciesIngested?: number;
  observedDependencies?: number;
  inferredDependencies?: number;
  rejected?: number;
}

interface PushInput {
  facilities: Facility[];
  events: InfraEvent[];
  dependencies: PalanterDependency[];
}

/**
 * Обрізає навантаження до того, що платформа справді приймає.
 *
 * Похідні оцінки (критичність, наслідки відмов) не надсилаються навмисно: у
 * платформі вони перераховуються з графа, а знімок учорашнього рейтингу,
 * покладений у сховище як факт, — це рівно та плутанина спостереженого з
 * виведеним, проти якої будувалася вся система походження.
 */
function toPayload(input: PushInput) {
  return {
    retrievedAt: new Date().toISOString(),
    facilities: input.facilities.map((f) => ({
      id: f.id,
      name: f.name,
      category: f.category,
      lat: f.lat,
      lon: f.lon,
      ...(f.operator === undefined ? {} : { operator: f.operator }),
      ...(f.detail === undefined ? {} : { detail: f.detail }),
      source: f.source,
    })),
    events: input.events.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      lat: e.lat,
      lon: e.lon,
      time: e.time,
      ...(e.magnitude === undefined ? {} : { magnitude: e.magnitude }),
      ...(e.url === undefined ? {} : { url: e.url }),
      source: e.source,
    })),
    dependencies: input.dependencies,
  };
}

function parseInput(raw: unknown): PushInput {
  const value = (raw ?? {}) as Partial<PushInput>;
  return {
    facilities: Array.isArray(value.facilities) ? value.facilities : [],
    events: Array.isArray(value.events) ? value.events : [],
    dependencies: Array.isArray(value.dependencies) ? value.dependencies : [],
  };
}

export const pushToPalanter = createServerFn({ method: "POST" })
  .validator(parseInput)
  .handler(async ({ data }): Promise<PalanterPushResult> => {
    const base = process.env["PALANTER_API_URL"];
    const key = process.env["PALANTER_API_KEY"];
    if (!base || !key) return { configured: false, ok: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/api/platform/ingest/infraua`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          payload: toPayload(data),
          source: "infraua-console",
          sector: "infrastructure",
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        // Тіло відповіді може бути HTML від проксі, а не JSON платформи.
        return { configured: true, ok: false, error: `${response.status}: ${text.slice(0, 200)}` };
      }

      const body = JSON.parse(text) as {
        facilitiesIngested?: number;
        eventsIngested?: number;
        dependenciesIngested?: number;
        observedDependencies?: number;
        inferredDependencies?: number;
        rejected?: unknown[];
      };
      return {
        configured: true,
        ok: true,
        facilitiesIngested: body.facilitiesIngested ?? 0,
        eventsIngested: body.eventsIngested ?? 0,
        dependenciesIngested: body.dependenciesIngested ?? 0,
        observedDependencies: body.observedDependencies ?? 0,
        inferredDependencies: body.inferredDependencies ?? 0,
        rejected: Array.isArray(body.rejected) ? body.rejected.length : 0,
      };
    } catch (err) {
      return {
        configured: true,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  });

/** Чи налаштований звʼязок із платформою — щоб не показувати мертву кнопку. */
export const palanterStatus = createServerFn({ method: "GET" }).handler(async () => ({
  configured: Boolean(process.env["PALANTER_API_URL"] && process.env["PALANTER_API_KEY"]),
}));

/**
 * Готує ребра до надсилання: залишає лише ті, обидва кінці яких є серед
 * обʼєктів, що йдуть у тому ж пакеті. Платформа й так повідомить про
 * посилання в нікуди, але надсилати їй завідомо биті — марна робота.
 */
export function pushableDependencies(
  facilities: Facility[],
  edges: GraphEdge[],
): PalanterDependency[] {
  const known = new Set(facilities.map((f) => f.id));
  return edges
    .filter((e) => known.has(e.from) && known.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, km: e.km, kind: e.kind, provenance: e.provenance }));
}

/** Скільки з надісланих ребер спиратимуться на факт, а скільки на здогадку. */
export function pushSplit(dependencies: PalanterDependency[]): {
  observed: number;
  inferred: number;
} {
  let observed = 0;
  for (const d of dependencies) if (isObserved(d.provenance)) observed++;
  return { observed, inferred: dependencies.length - observed };
}
