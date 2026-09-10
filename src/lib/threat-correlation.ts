/**
 * Кореляція «повітряна загроза → критичний обʼєкт» на боці консолі.
 *
 * Це порт шару «і що з того» тактичного радара в задеплоєну консоль. Радар має
 * курс цілі й будує коридор по траєкторії; відкрите джерело позначок
 * (detoyshahed) курсу не віддає, тож тут кореляція чесно рахується **за
 * близькістю** позначки до обʼєкта, а не за траєкторією. Активна тривога в
 * регіоні обʼєкта підвищує рівень — це незалежний офіційний сигнал.
 *
 * Функція чиста й безстанова: працює покадрово на клієнті (браузер тримає стан
 * між 30-с опитуваннями), тому не потребує серверної памʼяті — і живе прямо на
 * Cloudflare Workers-деплої.
 */

import { CATEGORIES, distanceKm, type CategoryId, type Facility } from "./infra-types";
import type { Threat } from "./air";
import {
  assessCredibility,
  warrantsEscalation,
  type CredibilityAssessment,
  type SourceRole,
} from "./source-credibility";

/** Категорії, удар по яких має найвищі наслідки (узгоджено з радаром). */
export const CRITICAL_CATEGORIES: ReadonlySet<CategoryId> = new Set<CategoryId>([
  "power_plant",
  "substation",
  "dam",
  "water",
  "hospital",
  "oil_gas",
  "government",
  "data_center",
]);

export type ThreatSeverity = "critical" | "high" | "medium";

export interface ThreatCorrelation {
  facility: Facility;
  /** Відстань до найближчої повітряної позначки, км. */
  nearestKm: number;
  /** Скільки позначок у радіусі. */
  threatCount: number;
  /** Скільки окремих OSINT-повідомлень стоїть за ними (сума reports). */
  reportCount: number;
  /** OSINT-канали, що дали ці позначки. */
  sources: string[];
  severity: ThreatSeverity;
  /** Чи обʼєкт у регіоні з активною тривогою (підсилює рівень). */
  inAlarmRegion: boolean;
  /**
   * Наскільки можна вірити тому, що стоїть за цим рівнем, за кодом
   * Адміралтейства. Досі всі канали важили однаково, тож одна позначка з
   * загальноновинного каналу давала той самий рівень, що й три канали
   * спостереження при активній тривозі.
   */
  credibility: CredibilityAssessment;
}

export interface CorrelateOptions {
  /** Радіус кореляції позначки з обʼєктом, км. */
  radiusKm?: number;
  /** Множина id обʼєктів у регіонах з активною тривогою. */
  alarmIds?: ReadonlySet<string>;
  /**
   * Роль джерела в переліку консолі. Без неї всі канали трактуються як
   * невідомі, і оцінка спирається лише на підтвердження — тобто працює, але
   * знає менше.
   */
  roleOf?: (source: string) => SourceRole;
}

function severityOf(
  nearestKm: number,
  critical: boolean,
  inAlarm: boolean,
  credible: boolean,
): ThreatSeverity {
  // Активна офіційна тривога підтягує обʼєкт на рівень вище.
  const boost = inAlarm ? 1 : 0;
  let base: 0 | 1 | 2; // 0=critical, 1=high, 2=medium
  if (critical && nearestKm <= 10) base = 0;
  else if (critical && nearestKm <= 25) base = 1;
  else if (nearestKm <= 12) base = 1;
  else base = 2;
  // Непідтверджене повідомлення від каналу, що зазвичай переказує, не піднімає
  // рівень. Це не недовіра до джерела — це відмова витрачати увагу чергового
  // на те, чого ніхто не підтвердив: коли все «критичне», критичного немає.
  const penalty = credible ? 0 : 1;
  const lvl = Math.min(2, Math.max(0, base - boost + penalty)) as 0 | 1 | 2;
  return (["critical", "high", "medium"] as const)[lvl];
}

const SEVERITY_ORDER: Record<ThreatSeverity, number> = { critical: 0, high: 1, medium: 2 };

/**
 * Для кожного обʼєкта, поруч з яким є повітряні позначки (у радіусі), рахує
 * рівень загрози. Повертає список, відсортований за терміновістю, потім за
 * близькістю. Обʼєкти без позначок поруч у результат не потрапляють.
 */
export function correlateAirThreats(
  facilities: Facility[],
  threats: Threat[],
  opts: CorrelateOptions = {},
): ThreatCorrelation[] {
  const radiusKm = opts.radiusKm ?? 30;
  const alarmIds = opts.alarmIds ?? new Set<string>();
  const roleOf = opts.roleOf ?? (() => "unknown" as SourceRole);
  if (!threats.length) return [];

  const out: ThreatCorrelation[] = [];
  for (const f of facilities) {
    let nearestKm = Infinity;
    let threatCount = 0;
    let reportCount = 0;
    const sources = new Set<string>();
    for (const t of threats) {
      const d = distanceKm(f, t);
      if (d <= radiusKm) {
        threatCount++;
        reportCount += t.reports ?? 1;
        if (d < nearestKm) nearestKm = d;
        for (const s of t.sources ?? (t.source ? [t.source] : [])) sources.add(s);
      }
    }
    if (threatCount === 0) continue;
    const critical = CRITICAL_CATEGORIES.has(f.category);
    const inAlarmRegion = alarmIds.has(f.id);
    const credibility = assessCredibility({
      sources: [...sources],
      roleOf,
      officialCorroboration: inAlarmRegion,
      reports: reportCount,
    });
    out.push({
      facility: f,
      nearestKm: Math.round(nearestKm * 10) / 10,
      threatCount,
      reportCount,
      sources: [...sources],
      severity: severityOf(nearestKm, critical, inAlarmRegion, warrantsEscalation(credibility)),
      inAlarmRegion,
      credibility,
    });
  }

  out.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.nearestKm - b.nearestKm,
  );
  return out;
}

/** Зведення для смуги обстановки: скільки обʼєктів під загрозою і скільки критичних. */
export function summarizeAirThreat(correlations: ThreatCorrelation[]): {
  total: number;
  critical: number;
  high: number;
} {
  let critical = 0;
  let high = 0;
  for (const c of correlations) {
    if (c.severity === "critical") critical++;
    else if (c.severity === "high") high++;
  }
  return { total: correlations.length, critical, high };
}

// ── Граф звʼязків: обʼєкт ↔ повітряна ціль ↔ OSINT-канал ────────────────────

export type GraphNodeKind = "asset" | "threat" | "channel";

export interface ThreatGraphNode {
  key: string;
  label: string;
  kind: GraphNodeKind;
  /** Рівень для обʼєкта (щоб фарбувати вузол за терміновістю). */
  severity?: ThreatSeverity;
  /** Ступінь звʼязків — для розміру вузла. */
  degree: number;
}

export interface ThreatGraphEdge {
  a: string;
  b: string;
  kind: "threatens" | "reported-by";
}

export interface ThreatGraph {
  nodes: ThreatGraphNode[];
  edges: ThreatGraphEdge[];
}

export interface BuildGraphOptions {
  radiusKm?: number;
  /** Скільки обʼєктів під загрозою взяти (найтерміновіші). */
  maxAssets?: number;
}

/**
 * Будує граф звʼязків оперативної картини: обʼєкти під повітряною загрозою, самі
 * позначки цілей поруч і OSINT-канали, що їх дали. Показує, коли кілька загроз
 * сходяться на один обʼєкт або коли один канал живить багато позначок — це
 * знаковий шар аналізу звʼязків Palantir-класу, тепер прямо в консолі.
 *
 * Чиста функція: працює покадрово, без серверної памʼяті.
 */
export function buildThreatGraph(
  correlations: ThreatCorrelation[],
  threats: Threat[],
  opts: BuildGraphOptions = {},
): ThreatGraph {
  const radiusKm = opts.radiusKm ?? 30;
  const maxAssets = opts.maxAssets ?? 14;
  const nodes = new Map<string, ThreatGraphNode>();
  const edges: ThreatGraphEdge[] = [];
  const edgeSeen = new Set<string>();

  const addNode = (key: string, label: string, kind: GraphNodeKind, severity?: ThreatSeverity) => {
    let n = nodes.get(key);
    if (!n) {
      n = { key, label, kind, degree: 0, ...(severity ? { severity } : {}) };
      nodes.set(key, n);
    }
    return n;
  };
  const addEdge = (a: string, b: string, kind: ThreatGraphEdge["kind"]) => {
    const id = `${a}|${b}`;
    if (edgeSeen.has(id)) return;
    edgeSeen.add(id);
    edges.push({ a, b, kind });
    nodes.get(a)!.degree++;
    nodes.get(b)!.degree++;
  };

  for (const c of correlations.slice(0, maxAssets)) {
    const aKey = `a:${c.facility.id}`;
    addNode(aKey, c.facility.name, "asset", c.severity);
    for (const t of threats) {
      if (distanceKm(c.facility, t) > radiusKm) continue;
      const tKey = `t:${t.id}`;
      addNode(tKey, t.name, "threat");
      addEdge(tKey, aKey, "threatens");
      for (const ch of t.sources ?? (t.source ? [t.source] : [])) {
        const cKey = `c:${ch}`;
        addNode(cKey, ch, "channel");
        addEdge(cKey, tKey, "reported-by");
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}
