import { GraphEdge, GraphNode, NodeType } from '../graph/types';
import { buildAdjacency } from '../analytics/GraphMetrics';
import { RiskAssessment } from '../analytics/RiskScorer';
import { AlertCondition, PropertyPredicate } from './AlertRule';

/**
 * Evaluates a standing query's condition against one clearance-filtered
 * snapshot, and says **why** each node matched.
 *
 * Evidence is not a nicety here. An alert that says only "this fired" gets
 * dismissed the third time it is wrong, and after that it gets dismissed when
 * it is right. The same reasoning that put a `reason` and an `evidence` string
 * on every risk signal applies with more force to something that interrupts a
 * person: the first question is always "why this one", and the alert has to
 * answer it without anyone opening a console.
 *
 * The snapshot is already filtered to the evaluating view (as everywhere else
 * in this platform), so a rule cannot match on a node the alert's eventual
 * readers could not see, and proximity cannot be computed against a hidden
 * neighbour.
 */

export interface MatchContext {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Risk assessments for this same snapshot, keyed by node id. */
  risk: Map<string, RiskAssessment>;
}

/**
 * A grid index over the nodes that carry coordinates.
 *
 * `proximity` asks "is there an Event within 15 km of this Asset", and the
 * straightforward answer scans every node for every node. On the Ukrainian set
 * - 4109 substations before anything else is loaded - that is sixteen million
 * distance computations per rule per sweep, and sweeps run on every ingest.
 *
 * Buckets are whole degrees of latitude and longitude. Deliberately crude: the
 * index only has to narrow the search, and the exact distance is computed
 * afterwards on the handful of candidates, so a loose bucket costs a few extra
 * haversines and never changes an answer. The lookup widens by however many
 * degrees the radius spans, so a large radius stays correct rather than
 * quietly truncating - the failure mode that would make a geofence miss the
 * thing it was drawn around.
 */
class GridIndex {
  private cells = new Map<string, GraphNode[]>();

  constructor(nodes: GraphNode[], type: NodeType) {
    for (const node of nodes) {
      if (node.type !== type) continue;
      const at = coordsOf(node);
      if (!at) continue;
      const key = cellKey(at.lat, at.lon);
      const cell = this.cells.get(key);
      if (cell) cell.push(node);
      else this.cells.set(key, [node]);
    }
  }

  /** Every indexed node in the cells a circle of `radiusKm` can reach. */
  near(at: { lat: number; lon: number }, radiusKm: number): GraphNode[] {
    // One degree of latitude is ~111 km; one of longitude is less, and shrinks
    // towards the poles. Using the latitude figure for both over-selects in
    // longitude, which is the safe direction.
    const span = Math.max(1, Math.ceil(radiusKm / 111));
    const found: GraphNode[] = [];
    const baseLat = Math.floor(at.lat);
    const baseLon = Math.floor(at.lon);
    for (let dLat = -span; dLat <= span; dLat++) {
      for (let dLon = -span; dLon <= span; dLon++) {
        const cell = this.cells.get(`${baseLat + dLat}:${baseLon + dLon}`);
        if (cell) found.push(...cell);
      }
    }
    return found;
  }
}

function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat)}:${Math.floor(lon)}`;
}

export interface ConditionMatch {
  node: GraphNode;
  /** One line per sub-condition that fired, in the order they were checked. */
  evidence: string[];
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(h));
}

function coordsOf(node: GraphNode): { lat: number; lon: number } | null {
  const lat = node.properties.lat;
  const lon = node.properties.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function testPredicate(node: GraphNode, predicate: PropertyPredicate): string | null {
  const actual = node.properties[predicate.property];
  const { op, value, property } = predicate;

  if (op === 'exists') return actual !== undefined && actual !== null ? `${property} is present` : null;
  if (actual === undefined || actual === null) return null;

  const describe = (verdict: string) => `${property}=${String(actual)} ${verdict}`;

  switch (op) {
    case 'eq':
      return actual === value ? describe(`equals ${String(value)}`) : null;
    case 'ne':
      return actual !== value ? describe(`differs from ${String(value)}`) : null;
    case 'contains':
      return typeof actual === 'string' && typeof value === 'string' && actual.toLowerCase().includes(value.toLowerCase())
        ? describe(`contains "${value}"`)
        : null;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // Only numbers compare as numbers. Comparing "110000" to 220000 as
      // strings would silently answer a different question than the one the
      // rule asked, and answer it wrongly.
      if (typeof actual !== 'number' || typeof value !== 'number') return null;
      const ok =
        op === 'gt' ? actual > value : op === 'gte' ? actual >= value : op === 'lt' ? actual < value : actual <= value;
      const symbol = { gt: '>', gte: '≥', lt: '<', lte: '≤' }[op];
      return ok ? describe(`${symbol} ${value}`) : null;
    }
    default:
      return null;
  }
}

/**
 * @returns the evidence lines when the node matches, or null when it does not.
 */
export function evaluateCondition(
  condition: AlertCondition,
  node: GraphNode,
  context: MatchContext,
  adjacency = buildAdjacency(context.nodes, context.edges),
  grids: Map<NodeType, GridIndex> = new Map(),
): string[] | null {
  const gridFor = (type: NodeType): GridIndex => {
    const existing = grids.get(type);
    if (existing) return existing;
    const built = new GridIndex(context.nodes, type);
    grids.set(type, built);
    return built;
  };

  switch (condition.kind) {
    case 'entity': {
      const evidence: string[] = [];
      if (condition.nodeType && node.type !== condition.nodeType) return null;
      if (condition.nodeType) evidence.push(`is a ${condition.nodeType}`);
      if (condition.labelContains) {
        if (!node.label.toLowerCase().includes(condition.labelContains.toLowerCase())) return null;
        evidence.push(`label contains "${condition.labelContains}"`);
      }
      for (const predicate of condition.properties ?? []) {
        const hit = testPredicate(node, predicate);
        if (hit === null) return null;
        evidence.push(hit);
      }
      // A bare `{kind:'entity'}` matches everything; say so rather than
      // returning an empty explanation that reads like a missing one.
      return evidence.length > 0 ? evidence : ['matches any entity'];
    }

    case 'risk': {
      const assessment = context.risk.get(node.id);
      if (!assessment || assessment.score < condition.minScore) return null;
      const top = assessment.signals
        .slice()
        .sort((a, b) => b.contribution - a.contribution)
        .slice(0, 2)
        .map((s) => s.label);
      return [
        `risk ${assessment.score} (${assessment.band}) ≥ ${condition.minScore}` +
          (top.length > 0 ? ` — mainly ${top.join(', ')}` : ''),
      ];
    }

    case 'geofence': {
      if (condition.nodeType && node.type !== condition.nodeType) return null;
      const here = coordsOf(node);
      if (!here) return null;
      const km = haversineKm(here, { lat: condition.lat, lon: condition.lon });
      if (km > condition.radiusKm) return null;
      return [`${km.toFixed(1)} km from ${condition.lat.toFixed(3)}, ${condition.lon.toFixed(3)} (fence ${condition.radiusKm} km)`];
    }

    case 'proximity': {
      const here = coordsOf(node);
      if (!here) return null;
      let nearest: { node: GraphNode; km: number } | null = null;
      for (const other of gridFor(condition.nearType).near(here, condition.radiusKm)) {
        if (other.id === node.id) continue;
        const there = coordsOf(other);
        if (!there) continue;
        const km = haversineKm(here, there);
        if (km <= condition.radiusKm && (nearest === null || km < nearest.km)) nearest = { node: other, km };
      }
      if (!nearest) return null;
      return [`${nearest.km.toFixed(1)} km from ${condition.nearType} "${nearest.node.label}" (within ${condition.radiusKm} km)`];
    }

    case 'degree': {
      const degree = adjacency.neighbors.get(node.id)?.size ?? 0;
      if (degree < condition.min) return null;
      return [`${degree} relations ≥ ${condition.min}`];
    }

    case 'relation': {
      const direction = condition.direction ?? 'any';
      const match = context.edges.find((e) => {
        if (e.relation !== condition.relation) return false;
        if (direction === 'out') return e.source === node.id;
        if (direction === 'in') return e.target === node.id;
        return e.source === node.id || e.target === node.id;
      });
      if (!match) return null;
      const otherId = match.source === node.id ? match.target : match.source;
      const other = context.nodes.find((n) => n.id === otherId);
      return [`${condition.relation} ↔ ${other?.label ?? otherId}`];
    }

    case 'all': {
      const evidence: string[] = [];
      for (const child of condition.of) {
        const hit = evaluateCondition(child, node, context, adjacency, grids);
        if (hit === null) return null;
        evidence.push(...hit);
      }
      return evidence;
    }

    case 'any': {
      for (const child of condition.of) {
        const hit = evaluateCondition(child, node, context, adjacency, grids);
        if (hit !== null) return hit;
      }
      return null;
    }

    default:
      return null;
  }
}

export function matchNodes(condition: AlertCondition, context: MatchContext): ConditionMatch[] {
  const adjacency = buildAdjacency(context.nodes, context.edges);
  // Built once for the whole sweep over this condition, not per node: the
  // index is the entire saving, and rebuilding it per node would be slower
  // than not having one.
  const grids = new Map<NodeType, GridIndex>();
  const matches: ConditionMatch[] = [];
  for (const node of context.nodes) {
    const evidence = evaluateCondition(condition, node, context, adjacency, grids);
    if (evidence !== null) matches.push({ node, evidence });
  }
  return matches;
}
