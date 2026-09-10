import * as crypto from 'crypto';
import { ClearanceLevel, parseClearance } from './Clearance';
import { normalizeCompartments, Viewer } from './Marking';

/**
 * Who is behind a key, and what they may see.
 *
 * A key used to resolve to a bare number. That answers "how high" and nothing
 * else, which leaves two questions the platform has to be able to answer:
 * *which* need-to-know circles this reader is in, and *who* they are. The
 * second one matters as much as the first - an audit trail that records a key
 * hash can prove a request happened but cannot name the person who made it,
 * and "which analyst pulled the substation list" is precisely the question a
 * system like this exists to answer.
 */
export interface Principal {
  /** Stable identifier of the person or service, from the key configuration. */
  id: string;
  clearance: ClearanceLevel;
  /** Need-to-know compartments this principal is read into. */
  compartments: string[];
  /**
   * Purposes this principal may assert on a request. Empty means unrestricted,
   * which is what every key configured in the short form gets.
   */
  purposes: string[];
}

export interface ApiKeyAuth {
  resolvePrincipal(key: string): Principal | null;
  resolveClearance(key: string): ClearanceLevel | null;
}

interface KeySpec {
  principal?: string;
  clearance?: string | number;
  compartments?: unknown;
  purposes?: unknown;
}

/**
 * Resolves an API key from the PLATFORM_API_KEYS environment variable, never
 * from a committed file. This closes a real hole in the earlier version of the
 * platform: every endpoint trusted a `clearance` value the caller supplied in
 * the request body or query string, so a PUBLIC caller could simply claim
 * "clearance": "TOP_SECRET" and read everything. The caller's rights are now
 * looked up server-side and the client-supplied value is ignored for reads.
 *
 * Two configuration shapes, both supported on purpose:
 *
 *   {"key": "SECRET"}
 *   {"key": {"principal": "olena", "clearance": "SECRET",
 *            "compartments": ["grid-topology"], "purposes": ["outage-response"]}}
 *
 * The short form is not deprecated - it is the right shape for a single-purpose
 * service key, and every deployment currently running uses it. It resolves to a
 * principal named after the key's own hash, cleared to that level, in no
 * compartments and restricted to no purpose. Fail-closed on need-to-know,
 * unchanged on everything else, so upgrading the platform does not silently
 * change who can read what.
 *
 * PLATFORM_API_KEYS is a demo/local bootstrap mechanism, not a production
 * secrets store - see .env.example for the "never commit real keys" warning
 * that already applies to every other credential in this repo.
 */
export class EnvApiKeyAuth implements ApiKeyAuth {
  private readonly keys: Record<string, string | number | KeySpec>;

  constructor(rawJson: string | undefined) {
    this.keys = rawJson ? JSON.parse(rawJson) : {};
  }

  static fromEnv(): EnvApiKeyAuth {
    return new EnvApiKeyAuth(process.env.PLATFORM_API_KEYS);
  }

  resolvePrincipal(key: string): Principal | null {
    const raw = this.keys[key];
    if (raw === undefined) return null;

    if (typeof raw === 'string' || typeof raw === 'number') {
      return {
        id: anonymousPrincipalId(key),
        clearance: parseClearance(raw, ClearanceLevel.PUBLIC),
        compartments: [],
        purposes: [],
      };
    }
    if (typeof raw !== 'object' || raw === null) return null;

    return {
      id: typeof raw.principal === 'string' && raw.principal.trim() ? raw.principal.trim() : anonymousPrincipalId(key),
      clearance: parseClearance(raw.clearance, ClearanceLevel.PUBLIC),
      // A malformed compartment list must not resolve to "no compartments",
      // which would quietly widen the key instead of rejecting it.
      compartments: normalizeCompartments(raw.compartments),
      purposes: normalizePurposes(raw.purposes),
    };
  }

  /** The view this principal reads the graph, index and cases through. */
  static viewerOf(principal: Principal): Viewer {
    return { clearance: principal.clearance, compartments: new Set(principal.compartments) };
  }

  resolveClearance(key: string): ClearanceLevel | null {
    return this.resolvePrincipal(key)?.clearance ?? null;
  }
}

/**
 * A name for a key whose configuration did not give one. Derived from the key
 * so it is stable across restarts, and hashed so the audit trail never carries
 * the credential itself.
 */
function anonymousPrincipalId(key: string): string {
  return `key:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

const PURPOSE_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizePurposes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (raw === null) throw new Error('Purposes must be an array of names or a comma-separated string.');

  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') throw new Error('Purpose names must be strings.');
    const cleaned = entry.trim().toLowerCase();
    if (!cleaned) continue;
    if (!PURPOSE_SHAPE.test(cleaned)) {
      throw new Error(`Invalid purpose "${entry}": expected a short identifier (max 64 characters).`);
    }
    seen.add(cleaned);
  }
  return Array.from(seen).sort();
}
