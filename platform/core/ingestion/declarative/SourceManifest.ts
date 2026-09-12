import { NodeType } from '../../graph/types';
import { OntologyManifest } from '../../graph/OntologyManifest';
import { ClearanceLevel, parseClearance } from '../../security/Clearance';
import { normalizeCompartments } from '../../security/Marking';
import { TRANSFORM_NAMES, TransformName } from './transforms';

/**
 * A data source described as a document rather than written as a class.
 *
 * Every connector in this platform so far - InfraUA, Prozorro, the company
 * register - is a hand-written class. Each one re-implements the same five
 * things: pick fields out of records, decide identity, apply a marking, attach
 * provenance, and set valid time. That is fine for three connectors and it is
 * the wrong shape for thirty: every new feed means new code in the ingestion
 * path, every author can forget an invariant, and nobody outside the codebase
 * can see what a feed actually does to the graph.
 *
 * A manifest inverts it. The feed's mapping becomes data: reviewable by an
 * operator, versioned in `config/sources/`, validated against the ontology
 * **when it is registered** rather than when data arrives, and executed by one
 * piece of code that cannot forget the invariants because they are not its
 * author's job to remember.
 *
 * ## What the framework guarantees, so a manifest cannot get it wrong
 *
 * - **Marking.** Clearance and compartments come from the manifest, clamped by
 *   the caller's own. A manifest cannot classify above its ingester.
 * - **Provenance.** Every node and edge carries the manifest id and the record
 *   it came from. There is no way to write an unattributed fact.
 * - **Valid time.** When the manifest names a field for it, it is applied; when
 *   it does not, absence is recorded as absence rather than as "now".
 * - **Ontology.** Relations are checked against the manifest of record at
 *   registration, so a mapping naming a relation that does not exist fails in
 *   front of the person writing it.
 *
 * ## What a manifest deliberately cannot do
 *
 * Run code. Transforms are a closed, named set (`transforms.ts`). A mapping
 * that can compute anything is a program running with the ingestion's rights,
 * and the entire value here is that it is a document instead.
 */

export interface FieldMapping {
  /**
   * Dotted path into the record: `identifier.id`, `awards.0.value.amount`.
   * Omitted when `const` is given.
   */
  from?: string;
  /**
   * A fixed value, for the field every record in a feed shares - the category
   * a whole source describes, a country, a kind. Distinct from `fallback`,
   * which only applies when a path is absent: a constant that had to be
   * spelled as "read this path and fall back" would silently take the path's
   * value whenever the path happened to exist.
   */
  const?: string | number | boolean;
  /** Named transforms, applied left to right. */
  transform?: TransformName[];
  /** Used when the path is absent or a transform gives up. */
  fallback?: string | number | boolean;
}

export interface PropertyMapping extends FieldMapping {
  name: string;
}

export interface EntityMapping {
  /** Referred to by edges in this manifest. Unique within it. */
  name: string;
  type: NodeType;
  /**
   * The identity of this entity, and the single most consequential line in a
   * manifest. Two records that produce the same id are the same thing; two
   * that do not are not. A prefix keeps one source's ids from colliding with
   * another's, and makes the key readable in the graph.
   */
  id: FieldMapping & { prefix?: string };
  label: FieldMapping;
  properties?: PropertyMapping[];
  /** When the fact starts holding in the world, if the record says. */
  validFrom?: FieldMapping;
  validTo?: FieldMapping;
  /**
   * Marks this entity as personal data, which raises its default clearance and
   * puts it in the personal-data compartment unless the manifest says
   * otherwise. Named on the entity because whether a feed carries people is a
   * property of the feed, not a decision for whoever ingests it.
   */
  personal?: boolean;
  /**
   * This entity is absent from most records, and that is normal rather than a
   * fault.
   *
   * Real feeds are sparse: Wikidata names an operator for 7 of 244 Ukrainian
   * power plants. Without this, the other 237 records each report a skipped
   * entity, and a `skipped` list of 237 entries is a list nobody reads - which
   * is how the one record that really was malformed stops being visible.
   *
   * Edges that reference an optional entity are simply not written for records
   * where it is missing.
   */
  optional?: boolean;
}

export interface EdgeMapping {
  relation: string;
  /** Name of an entity declared in this manifest. */
  from: string;
  to: string;
  properties?: PropertyMapping[];
  validFrom?: FieldMapping;
  validTo?: FieldMapping;
}

/**
 * A record this feed is known to carry and known not to want.
 *
 * Every real register has a handful of rows that are wrong in a way no mapping
 * can express. Wikidata publishes the Donetsk agglomeration as an ordinary
 * settlement - same type, same shape, 1.56 million people already counted in
 * the cities inside it - and nothing in the record distinguishes it from a
 * city. The choice is between silently accepting the double count and dropping
 * it by name.
 *
 * Dropping it by name is the honest one, on one condition: the reason is
 * required and travels with the record in the ingest report. An exclusion
 * without a stated reason is indistinguishable from data somebody found
 * inconvenient.
 */
export interface ExclusionRule {
  /** Dotted path into the record, as everywhere else. */
  from: string;
  /** Compared as text, so a numeric id and its string form both match. */
  equals: string;
  /** Why this record is not wanted. Required. */
  reason: string;
}

/**
 * Where a feed's records come from, so the whole feed is one document.
 *
 * Without this a manifest describes half a source: the mapping is reviewable
 * and versioned, and the query that produced the records lives in somebody's
 * shell history. Two people then disagree about what "the settlements feed"
 * means and both are right about their half.
 *
 * The constraints are not decoration. A manifest that can name any URL makes
 * the server issue requests on behalf of whoever wrote it, so:
 *
 * - **https only, and no userinfo in the URL.** Credentials in a reviewed
 *   document end up in version control, which is the one place they must not be.
 * - **No authorization-bearing headers.** Same reason, and it draws the line
 *   plainly: a manifest describes a mapping, not an identity. Feeds that need a
 *   key stay hand-written connectors until there is a secret store to name.
 * - **Host allowlist**, and it lives in the deployment's own policy, never in
 *   the manifest. A document that names the hosts it may reach is a document
 *   that grants itself the right.
 */
export interface FetchSpec {
  url: string;
  method: 'GET' | 'POST';
  /** Appended as query parameters, so a long SPARQL query stays readable. */
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Sent as-is for POST. */
  body?: string;
}

/** Headers a manifest may not set, because each one carries an identity. */
const FORBIDDEN_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key'];

function parseFetch(raw: unknown): FetchSpec {
  if (typeof raw !== 'object' || raw === null) throw new ManifestError('fetch must be an object');
  const spec = raw as Record<string, unknown>;

  if (typeof spec.url !== 'string' || !spec.url) throw new ManifestError('fetch.url is required');
  let parsed: URL;
  try {
    parsed = new URL(spec.url);
  } catch {
    throw new ManifestError(`fetch.url "${spec.url}" is not a URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ManifestError('fetch.url must be https — a feed read over plaintext can be rewritten in transit');
  }
  if (parsed.username || parsed.password) {
    throw new ManifestError('fetch.url must not carry credentials — a manifest is a reviewed document, not a secret store');
  }

  const method = spec.method === undefined ? 'GET' : String(spec.method).toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new ManifestError('fetch.method must be GET or POST');

  const query: Record<string, string> = {};
  if (spec.query !== undefined) {
    if (typeof spec.query !== 'object' || spec.query === null) throw new ManifestError('fetch.query must be an object');
    for (const [key, value] of Object.entries(spec.query as Record<string, unknown>)) {
      query[key] = String(value);
    }
  }

  const headers: Record<string, string> = {};
  if (spec.headers !== undefined) {
    if (typeof spec.headers !== 'object' || spec.headers === null) throw new ManifestError('fetch.headers must be an object');
    for (const [key, value] of Object.entries(spec.headers as Record<string, unknown>)) {
      if (FORBIDDEN_HEADERS.includes(key.toLowerCase())) {
        throw new ManifestError(`fetch.headers may not set "${key}" — a manifest describes a mapping, not an identity`);
      }
      headers[key] = String(value);
    }
  }

  return {
    url: spec.url,
    method,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(typeof spec.body === 'string' && spec.body ? { body: spec.body } : {}),
  };
}

export interface SourceManifest {
  id: string;
  title: string;
  /** What this feed is and what it is for. Required; read by whoever reviews it. */
  description: string;
  sector: string;
  /**
   * Where the records live inside the payload. Empty means the payload is
   * itself the array.
   */
  recordsAt?: string;
  /** Fields joined to make each record's searchable text. */
  text?: FieldMapping[];
  defaultClearance: ClearanceLevel;
  compartments: string[];
  entities: EntityMapping[];
  edges: EdgeMapping[];
  /**
   * This feed writes Ukrainian critical-infrastructure objects.
   *
   * Declared by the manifest and acted on by the deployment: a feed says what
   * it carries, and whether that is acceptable here is not the feed author's
   * call. Registration refuses such a manifest unless the deployment has
   * turned these layers on (`core/ingestion/InfraLayers.ts`).
   */
  criticalInfrastructure?: boolean;
  /** Records dropped by name, each with the reason it is dropped. */
  exclude?: ExclusionRule[];
  /** How the platform pulls this feed itself, when it can. */
  fetch?: FetchSpec;
  /** Bumped by whoever edits the manifest; recorded with everything it writes. */
  version: number;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(`Invalid source manifest: ${message}`);
    this.name = 'ManifestError';
  }
}

const NODE_TYPES = new Set<NodeType>(['Person', 'Organization', 'Asset', 'Location', 'Event']);
const ID_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseField(raw: unknown, where: string): FieldMapping {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestError(`${where} must be an object with a "from" path or a "const" value`);
  }
  const field = raw as Record<string, unknown>;
  const hasConst = field.const !== undefined;
  if (!hasConst && (typeof field.from !== 'string' || !field.from)) {
    throw new ManifestError(`${where} needs either a non-empty "from" path or a "const" value`);
  }
  if (hasConst && field.from !== undefined) {
    // Both would leave the reader guessing which wins, and the answer would
    // depend on whether the path happened to exist in that record.
    throw new ManifestError(`${where} declares both "from" and "const" — pick one`);
  }

  const transform = field.transform;
  if (transform !== undefined) {
    if (!Array.isArray(transform)) throw new ManifestError(`${where}.transform must be an array of names`);
    for (const name of transform) {
      if (!TRANSFORM_NAMES.includes(name as TransformName)) {
        throw new ManifestError(`${where}.transform names "${String(name)}", which is not a transform. Available: ${TRANSFORM_NAMES.join(', ')}.`);
      }
    }
  }

  return {
    ...(hasConst ? { const: field.const as string | number | boolean } : { from: field.from as string }),
    ...(transform ? { transform: transform as TransformName[] } : {}),
    ...(field.fallback !== undefined ? { fallback: field.fallback as string | number | boolean } : {}),
  };
}

function parseProperties(raw: unknown, where: string): PropertyMapping[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError(`${where} must be an array`);
  return raw.map((entry, index) => {
    const property = entry as Record<string, unknown>;
    if (typeof property.name !== 'string' || !property.name) {
      throw new ManifestError(`${where}[${index}].name is required`);
    }
    return { name: property.name, ...parseField(entry, `${where}[${index}]`) };
  });
}

/**
 * Validates a manifest, including against the ontology when one is supplied.
 *
 * Checking relations here rather than at ingest is the point: a mapping that
 * names a relation the ontology does not declare fails in front of the person
 * writing it, not at three in the morning against real data - and not silently
 * per row, which is how a feed ends up half-connected with nobody noticing.
 */
export function parseSourceManifest(raw: unknown, ontology?: OntologyManifest): SourceManifest {
  if (typeof raw !== 'object' || raw === null) throw new ManifestError('a manifest must be an object');
  const manifest = raw as Record<string, unknown>;

  if (typeof manifest.id !== 'string' || !ID_SHAPE.test(manifest.id)) {
    throw new ManifestError('id must be a short identifier of letters, digits, dot, dash or underscore');
  }
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) throw new ManifestError('title is required');
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    // Not decoration: this is what an operator reads when deciding whether a
    // feed should be writing to their graph at all.
    throw new ManifestError('description is required — it is what an operator reads when reviewing this feed');
  }
  if (typeof manifest.sector !== 'string' || !manifest.sector.trim()) throw new ManifestError('sector is required');

  const entitiesRaw = manifest.entities;
  if (!Array.isArray(entitiesRaw) || entitiesRaw.length === 0) {
    throw new ManifestError('entities must be a non-empty array');
  }

  const entities: EntityMapping[] = entitiesRaw.map((entry, index) => {
    const entity = entry as Record<string, unknown>;
    const where = `entities[${index}]`;
    if (typeof entity.name !== 'string' || !entity.name) throw new ManifestError(`${where}.name is required`);
    if (!NODE_TYPES.has(entity.type as NodeType)) {
      throw new ManifestError(`${where}.type "${String(entity.type)}" is not an entity type`);
    }
    if (ontology && !ontology.isKnownEntityType(String(entity.type))) {
      throw new ManifestError(`${where}.type "${String(entity.type)}" is not declared in the ontology manifest`);
    }

    const idRaw = entity.id as Record<string, unknown> | undefined;
    const id = { ...parseField(idRaw, `${where}.id`) } as FieldMapping & { prefix?: string };
    if (idRaw?.prefix !== undefined) {
      if (typeof idRaw.prefix !== 'string') throw new ManifestError(`${where}.id.prefix must be a string`);
      id.prefix = idRaw.prefix;
    }

    return {
      name: entity.name,
      type: entity.type as NodeType,
      id,
      label: parseField(entity.label, `${where}.label`),
      properties: parseProperties(entity.properties, `${where}.properties`),
      ...(entity.validFrom ? { validFrom: parseField(entity.validFrom, `${where}.validFrom`) } : {}),
      ...(entity.validTo ? { validTo: parseField(entity.validTo, `${where}.validTo`) } : {}),
      ...(entity.personal === true ? { personal: true } : {}),
      ...(entity.optional === true ? { optional: true } : {}),
    };
  });

  const names = new Set<string>();
  for (const entity of entities) {
    if (names.has(entity.name)) throw new ManifestError(`two entities are both named "${entity.name}"`);
    names.add(entity.name);
  }
  const typeOf = new Map(entities.map((e) => [e.name, e.type]));

  const edgesRaw = manifest.edges ?? [];
  if (!Array.isArray(edgesRaw)) throw new ManifestError('edges must be an array');
  const edges: EdgeMapping[] = edgesRaw.map((entry, index) => {
    const edge = entry as Record<string, unknown>;
    const where = `edges[${index}]`;
    if (typeof edge.relation !== 'string' || !edge.relation) throw new ManifestError(`${where}.relation is required`);
    if (typeof edge.from !== 'string' || !names.has(edge.from)) {
      throw new ManifestError(`${where}.from "${String(edge.from)}" is not an entity declared in this manifest`);
    }
    if (typeof edge.to !== 'string' || !names.has(edge.to)) {
      throw new ManifestError(`${where}.to "${String(edge.to)}" is not an entity declared in this manifest`);
    }

    if (ontology) {
      const check = ontology.validateEdge(edge.relation, typeOf.get(edge.from)!, typeOf.get(edge.to)!);
      if (!check.valid) throw new ManifestError(`${where}: ${check.reason}`);
    }

    return {
      relation: edge.relation,
      from: edge.from,
      to: edge.to,
      properties: parseProperties(edge.properties, `${where}.properties`),
      ...(edge.validFrom ? { validFrom: parseField(edge.validFrom, `${where}.validFrom`) } : {}),
      ...(edge.validTo ? { validTo: parseField(edge.validTo, `${where}.validTo`) } : {}),
    };
  });

  const fetchSpec = manifest.fetch === undefined ? undefined : parseFetch(manifest.fetch);

  const excludeRaw = manifest.exclude;
  if (excludeRaw !== undefined && !Array.isArray(excludeRaw)) throw new ManifestError('exclude must be an array');
  const exclude = (excludeRaw as unknown[] | undefined)?.map((entry, index) => {
    const rule = entry as Record<string, unknown>;
    const where = `exclude[${index}]`;
    if (typeof rule.from !== 'string' || !rule.from) throw new ManifestError(`${where}.from is required`);
    if (rule.equals === undefined || rule.equals === null || String(rule.equals) === '') {
      throw new ManifestError(`${where}.equals is required`);
    }
    if (typeof rule.reason !== 'string' || !rule.reason.trim()) {
      // The whole difference between an exclusion and a quiet deletion.
      throw new ManifestError(`${where}.reason is required — an exclusion without a stated reason is a deletion`);
    }
    return { from: rule.from, equals: String(rule.equals), reason: rule.reason.trim() };
  });

  const textRaw = manifest.text;
  if (textRaw !== undefined && !Array.isArray(textRaw)) throw new ManifestError('text must be an array of fields');
  const text = (textRaw as unknown[] | undefined)?.map((entry, index) => parseField(entry, `text[${index}]`));

  return {
    id: manifest.id,
    title: manifest.title.trim(),
    description: manifest.description.trim(),
    sector: manifest.sector.trim(),
    ...(typeof manifest.recordsAt === 'string' && manifest.recordsAt ? { recordsAt: manifest.recordsAt } : {}),
    ...(text ? { text } : {}),
    defaultClearance: parseClearance(manifest.defaultClearance, ClearanceLevel.PUBLIC),
    compartments: normalizeCompartments(manifest.compartments),
    entities,
    edges,
    ...(manifest.criticalInfrastructure === true ? { criticalInfrastructure: true } : {}),
    ...(exclude && exclude.length > 0 ? { exclude } : {}),
    ...(fetchSpec ? { fetch: fetchSpec } : {}),
    version: typeof manifest.version === 'number' && manifest.version > 0 ? manifest.version : 1,
  };
}
