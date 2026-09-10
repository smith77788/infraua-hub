import { ClearanceLevel, clearanceAtLeast } from './Clearance';

/**
 * Need-to-know on top of the hierarchical clearance ladder.
 *
 * `ClearanceLevel` alone answers only "how high is this reader". That is a
 * chain of command, not a distribution rule: it says a SECRET analyst may see
 * every SECRET fact in the system, which is exactly what a compartment exists
 * to deny. The grid topology of one operator, the personal data of its staff,
 * and an ongoing procurement investigation can all sit at SECRET and still be
 * three separate need-to-know circles.
 *
 * So a marking is a pair: a level, and a set of compartments. A reader sees a
 * fact when they are cleared **at or above** its level **and** read into
 * **every** compartment on it. Compartments intersect rather than union: two
 * compartments on one node mean both are required, because a fact that came
 * out of two restricted circles belongs to neither alone.
 *
 * ## Why an unmarked reader is a real reader
 *
 * `asViewer` accepts a bare `ClearanceLevel` and turns it into a viewer with
 * no compartments. That is not a compatibility shim - it is the correct
 * reading of "cleared to SECRET, read into nothing". Such a reader sees every
 * uncompartmented fact at or below SECRET and no compartmented one. The
 * failure mode is refusal, never disclosure, which is the direction a default
 * has to fail in.
 */

export interface Marking {
  clearance: ClearanceLevel;
  /**
   * Compartments required to read this. Absent or empty means the level alone
   * decides - the ordinary case, and the one every existing record is in.
   */
  compartments?: readonly string[];
}

export interface Viewer {
  clearance: ClearanceLevel;
  compartments: ReadonlySet<string>;
}

/** What every read method accepts: a bare level, or a level plus compartments. */
export type ViewerInput = ClearanceLevel | Viewer;

/**
 * Compartment names are identifiers, not prose.
 *
 * Without a shape rule a compartment is whatever a caller typed, and
 * "Grid Topology", "grid topology" and "grid-topology" become three different
 * circles that each deny the others - a need-to-know system that fails closed
 * on a typo silently locks data away from the people it was marked for. So the
 * name is lowercased and trimmed, and anything that is not a short identifier
 * is rejected loudly at the boundary rather than quietly stored.
 */
const COMPARTMENT_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeCompartment(value: string): string {
  const cleaned = value.trim().toLowerCase();
  if (!COMPARTMENT_SHAPE.test(cleaned)) {
    throw new Error(
      `Invalid compartment "${value}": expected a short identifier of letters, digits, dot, dash or underscore (max 64 characters).`,
    );
  }
  return cleaned;
}

/**
 * Parses whatever arrived over the wire into a compartment list. Accepts an
 * array or a comma-separated string, because a header carries the latter and a
 * JSON body the former. Sorted and deduplicated so two orderings of the same
 * set compare and persist identically.
 */
export function normalizeCompartments(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : null;
  if (raw === null) throw new Error('Compartments must be an array of names or a comma-separated string.');

  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') throw new Error('Compartment names must be strings.');
    if (!entry.trim()) continue;
    seen.add(normalizeCompartment(entry));
  }
  return Array.from(seen).sort();
}

export function viewer(clearance: ClearanceLevel, compartments: Iterable<string> = []): Viewer {
  return { clearance, compartments: new Set(compartments) };
}

const NO_COMPARTMENTS: ReadonlySet<string> = new Set<string>();

export function asViewer(input: ViewerInput): Viewer {
  return typeof input === 'number' ? { clearance: input, compartments: NO_COMPARTMENTS } : input;
}

/** Cleared high enough, and read into every compartment the marking carries. */
export function canRead(who: ViewerInput, marking: Marking): boolean {
  const v = asViewer(who);
  if (!clearanceAtLeast(v.clearance, marking.clearance)) return false;
  for (const required of marking.compartments ?? []) {
    if (!v.compartments.has(required)) return false;
  }
  return true;
}

/**
 * Merges compartments already on a record with compartments arriving on a new
 * assertion about it, by **union**.
 *
 * Union rather than replacement because ingestion is not a declassification
 * path. A record touched by a restricted feed and later re-asserted by an open
 * one holds facts from both; letting the second write drop the first's
 * compartment would strip a marking through the most routine operation in the
 * system, and nobody would see it happen. Marking comes off through retraction,
 * which is deliberate, gated and audited.
 */
export function mergeCompartments(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): string[] {
  if (!existing?.length && !incoming?.length) return [];
  return Array.from(new Set([...(existing ?? []), ...(incoming ?? [])])).sort();
}

/** The compartments needed to read everything in a set — the union, again. */
export function unionCompartments(sets: (readonly string[] | undefined)[]): string[] {
  const all = new Set<string>();
  for (const set of sets) for (const c of set ?? []) all.add(c);
  return Array.from(all).sort();
}
