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
    version: typeof manifest.version === 'number' && manifest.version > 0 ? manifest.version : 1,
  };
}
