import { NodeType } from '../graph/types';
import { ClearanceLevel, parseClearance } from '../security/Clearance';
import { normalizeCompartments } from '../security/Marking';

/**
 * A standing query: a condition kept on file and re-evaluated as data arrives,
 * instead of a question somebody has to remember to ask again.
 *
 * The console already correlates air threats against facilities - per frame, in
 * the browser, gone on reload. That is a **view**, and a view cannot tell you
 * that something started mattering while nobody was looking. The difference
 * between a view and a standing query is the whole operational value of this
 * layer: one shows the picture to whoever is at the screen, the other reaches
 * out when the picture changes and keeps a record that it did.
 *
 * ## Why the condition is data and not code
 *
 * What is worth waking someone for is an operational judgement that changes
 * week to week, and it belongs to the operator, not to a release. So a rule is
 * a document: declarative, versionable, reviewable by someone who does not
 * read TypeScript, and - the part that matters most - **explainable**. Every
 * match comes back with the evidence that produced it, in the same shape the
 * risk scorer uses, because an alert nobody can take apart is an alert people
 * learn to dismiss.
 */

export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';

export interface PropertyPredicate {
  property: string;
  op: ComparisonOp;
  value?: string | number | boolean;
}

export type AlertCondition =
  /** A node of some type whose label and properties match. */
  | { kind: 'entity'; nodeType?: NodeType; labelContains?: string; properties?: PropertyPredicate[] }
  /** The explainable risk score is at or above a threshold. */
  | { kind: 'risk'; minScore: number }
  /** A node inside a circle on the map - the geofence. */
  | { kind: 'geofence'; lat: number; lon: number; radiusKm: number; nodeType?: NodeType }
  /** A node of one type within range of any node of another - "event near asset". */
  | { kind: 'proximity'; nearType: NodeType; radiusKm: number }
  /** Structural: more relations than a threshold. */
  | { kind: 'degree'; min: number }
  /** Holds a relation of this name. */
  | { kind: 'relation'; relation: string; direction?: 'in' | 'out' | 'any' }
  | { kind: 'all'; of: AlertCondition[] }
  | { kind: 'any'; of: AlertCondition[] };

export type AlertSeverity = 'info' | 'elevated' | 'high' | 'critical';

export const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  info: 0,
  elevated: 1,
  high: 2,
  critical: 3,
};

export interface AlertRule {
  id: string;
  name: string;
  /** What this rule is for, in the operator's words. Shown next to every firing. */
  description: string;
  enabled: boolean;
  severity: AlertSeverity;
  condition: AlertCondition;
  /**
   * Floor on the marking of alerts this rule produces. The real marking is
   * this raised to cover the entity that matched - an alert about a
   * compartmented substation is itself in that compartment, or it is a leak
   * with a siren attached.
   */
  clearance: ClearanceLevel;
  compartments: string[];
  /**
   * How long a resolved alert stays closed before the same condition may
   * reopen it. Without this a condition that keeps holding - a substation that
   * stays inside a geofence because it has not moved - produces a new alert
   * every evaluation and buries the queue. With it too long, a genuine
   * recurrence is missed. Default one hour.
   */
  reopenAfterMinutes: number;
}

const VALID_KINDS = new Set([
  'entity',
  'risk',
  'geofence',
  'proximity',
  'degree',
  'relation',
  'all',
  'any',
]);

const VALID_OPS = new Set<ComparisonOp>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']);
const VALID_NODE_TYPES = new Set<string>(['Person', 'Organization', 'Asset', 'Location', 'Event']);

function fail(message: string): never {
  throw new Error(`Invalid alert rule: ${message}`);
}

/**
 * Validates a condition tree.
 *
 * Rejecting a malformed rule at the boundary rather than at evaluation time is
 * not tidiness: a rule that throws mid-evaluation takes down the whole sweep,
 * and the alerts that would have fired from the *other* rules never happen.
 * A monitoring system that goes quiet on a typo is worse than no monitoring,
 * because silence reads as "nothing is wrong".
 */
export function validateCondition(condition: unknown, depth = 0): AlertCondition {
  if (depth > 5) fail('condition nests deeper than 5 levels');
  if (typeof condition !== 'object' || condition === null) fail('condition must be an object');
  const c = condition as Record<string, unknown>;
  const kind = c.kind;
  if (typeof kind !== 'string' || !VALID_KINDS.has(kind)) {
    fail(`unknown condition kind ${JSON.stringify(kind)} (expected one of ${Array.from(VALID_KINDS).join(', ')})`);
  }

  switch (kind) {
    case 'entity': {
      if (c.nodeType !== undefined && !VALID_NODE_TYPES.has(String(c.nodeType))) fail(`unknown nodeType ${String(c.nodeType)}`);
      if (c.labelContains !== undefined && typeof c.labelContains !== 'string') fail('labelContains must be a string');
      const properties = c.properties;
      if (properties !== undefined) {
        if (!Array.isArray(properties)) fail('properties must be an array');
        for (const raw of properties) {
          const p = raw as Record<string, unknown>;
          if (typeof p?.property !== 'string' || !p.property) fail('each property predicate needs a property name');
          if (!VALID_OPS.has(p.op as ComparisonOp)) fail(`unknown operator ${String(p.op)}`);
          if (p.op !== 'exists' && p.value === undefined) fail(`operator ${String(p.op)} needs a value`);
        }
      }
      return condition as AlertCondition;
    }
    case 'risk':
      if (typeof c.minScore !== 'number' || c.minScore < 0 || c.minScore > 100) fail('risk.minScore must be a number in 0..100');
      return condition as AlertCondition;
    case 'geofence':
      if (typeof c.lat !== 'number' || typeof c.lon !== 'number') fail('geofence needs numeric lat and lon');
      if (typeof c.radiusKm !== 'number' || c.radiusKm <= 0) fail('geofence.radiusKm must be a positive number');
      if (c.nodeType !== undefined && !VALID_NODE_TYPES.has(String(c.nodeType))) fail(`unknown nodeType ${String(c.nodeType)}`);
      return condition as AlertCondition;
    case 'proximity':
      if (!VALID_NODE_TYPES.has(String(c.nearType))) fail(`proximity.nearType must be a node type`);
      if (typeof c.radiusKm !== 'number' || c.radiusKm <= 0) fail('proximity.radiusKm must be a positive number');
      return condition as AlertCondition;
    case 'degree':
      if (typeof c.min !== 'number' || c.min < 0) fail('degree.min must be a non-negative number');
      return condition as AlertCondition;
    case 'relation':
      if (typeof c.relation !== 'string' || !c.relation) fail('relation needs a relation name');
      if (c.direction !== undefined && !['in', 'out', 'any'].includes(String(c.direction))) fail('relation.direction must be in, out or any');
      return condition as AlertCondition;
    case 'all':
    case 'any': {
      if (!Array.isArray(c.of) || c.of.length === 0) fail(`${kind} needs a non-empty "of" array`);
      for (const child of c.of) validateCondition(child, depth + 1);
      return condition as AlertCondition;
    }
    default:
      fail(`unhandled kind ${kind}`);
  }
}

export function parseRule(raw: unknown): AlertRule {
  if (typeof raw !== 'object' || raw === null) fail('a rule must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(r.id)) {
    fail('id must be a short identifier of letters, digits, dot, dash or underscore');
  }
  if (typeof r.name !== 'string' || !r.name.trim()) fail('name is required');
  if (typeof r.description !== 'string' || !r.description.trim()) {
    // Not decoration: this text is what the person woken at 03:00 reads first.
    fail('description is required — it is what an operator reads when the rule fires');
  }
  const severity = String(r.severity ?? 'elevated') as AlertSeverity;
  if (!(severity in SEVERITY_ORDER)) fail(`unknown severity ${severity}`);

  return {
    id: r.id,
    name: r.name.trim(),
    description: r.description.trim(),
    enabled: r.enabled !== false,
    severity,
    condition: validateCondition(r.condition),
    clearance: parseClearance(r.clearance, ClearanceLevel.PUBLIC),
    compartments: normalizeCompartments(r.compartments),
    reopenAfterMinutes:
      typeof r.reopenAfterMinutes === 'number' && r.reopenAfterMinutes >= 0 ? r.reopenAfterMinutes : 60,
  };
}
