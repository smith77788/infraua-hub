import { GraphStore } from '../../graph/GraphStore';
import { VectorIndex, IndexedDocument } from '../../vector/VectorIndex';
import { AuditLog } from '../../audit/AuditLog';
import { ClearanceLevel } from '../../security/Clearance';
import { unionCompartments } from '../../security/Marking';
import { PERSONAL_DATA_COMPARTMENT } from '../EdrConnector';
import { EntityMapping, ExclusionRule, FieldMapping, PropertyMapping, SourceManifest } from './SourceManifest';
import { applyTransforms, readPath } from './transforms';

/**
 * Executes a source manifest against a batch of records.
 *
 * One piece of code for every declarative feed, which is what makes the
 * invariants hold: marking, provenance and valid time are applied here, not in
 * each connector's author's head. A manifest can describe a feed wrongly; it
 * cannot describe one that writes an unattributed or unmarked fact, because
 * the manifest never gets to decide those.
 */

export interface DeclarativeIngestResult {
  source: string;
  manifestVersion: number;
  recordsRead: number;
  recordsIngested: number;
  nodesCreated: number;
  edgesCreated: number;
  /** Records dropped, with the reason — never silently skipped. */
  skipped: { record: number; reason: string }[];
  /** Records the manifest drops by name, with the reason it gives. */
  excluded: { record: number; matched: string; reason: string }[];
  rejected: { edge: string; reason: string }[];
  documents: IndexedDocument[];
}

export interface DeclarativeIngestOptions {
  /** Clamp: the batch is written at most at this level. */
  callerClearance: ClearanceLevel;
  /** Compartments the caller holds; the manifest's own are intersected with these. */
  callerCompartments: readonly string[];
  /** Overrides the manifest's sector, when a deployment separates feeds differently. */
  sector?: string;
}

function resolve(record: unknown, mapping: FieldMapping): string | number | boolean | null {
  if (mapping.const !== undefined) return mapping.const;
  const raw = readPath(record, mapping.from!);
  if (raw === undefined || raw === null || raw === '') {
    return mapping.fallback !== undefined ? mapping.fallback : null;
  }
  if (!mapping.transform || mapping.transform.length === 0) {
    return typeof raw === 'object' ? JSON.stringify(raw) : (raw as string | number | boolean);
  }
  const transformed = applyTransforms(mapping.transform, raw);
  return transformed === null && mapping.fallback !== undefined ? mapping.fallback : transformed;
}

/** The first rule that matches this record, if the manifest names any. */
function excludedBy(record: unknown, rules: ExclusionRule[] | undefined): ExclusionRule | null {
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    const value = readPath(record, rule.from);
    if (value !== undefined && value !== null && String(value) === rule.equals) return rule;
  }
  return null;
}

function collectProperties(record: unknown, mappings: PropertyMapping[] = []): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const mapping of mappings) {
    const value = resolve(record, mapping);
    // An absent property is absent, not empty: writing `null` would make
    // "we did not learn this" indistinguishable from "the source says none".
    if (value !== null) properties[mapping.name] = value;
  }
  return properties;
}

function validity(record: unknown, from?: FieldMapping, to?: FieldMapping): { validFrom?: string; validTo?: string } {
  const start = from ? resolve(record, from) : null;
  const end = to ? resolve(record, to) : null;
  return {
    ...(typeof start === 'string' && start ? { validFrom: start } : {}),
    ...(typeof end === 'string' && end ? { validTo: end } : {}),
  };
}

export class DeclarativeConnector {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorIndex,
    private readonly audit: AuditLog,
  ) {}

  /** Pulls the record array out of a payload, per the manifest's `recordsAt`. */
  static recordsOf(manifest: SourceManifest, payload: unknown): unknown[] {
    const at = manifest.recordsAt;
    const found = at ? readPath(payload, at) : payload;
    if (!Array.isArray(found)) {
      throw new Error(
        at
          ? `No array of records at "${at}" in the payload for "${manifest.id}".`
          : `The payload for "${manifest.id}" is not an array of records.`,
      );
    }
    return found;
  }

  ingest(
    manifest: SourceManifest,
    payload: unknown,
    options: DeclarativeIngestOptions,
  ): DeclarativeIngestResult {
    const records = DeclarativeConnector.recordsOf(manifest, payload);

    // A feed classifies at its own declared level or the caller's, whichever
    // is lower. A manifest cannot classify above the person running it.
    const clearance = Math.min(manifest.defaultClearance, options.callerClearance) as ClearanceLevel;

    // Compartments the manifest asks for, kept only where the caller holds
    // them: marking data into a circle the ingester is not in would write
    // facts they can never read back to check.
    const held = new Set(options.callerCompartments);
    const baseCompartments = manifest.compartments.filter((c) => held.has(c));

    const result: DeclarativeIngestResult = {
      source: manifest.id,
      manifestVersion: manifest.version,
      recordsRead: records.length,
      recordsIngested: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      skipped: [],
      excluded: [],
      rejected: [],
      documents: [],
    };

    const seenNodes = new Set<string>();

    this.graph.runBatch(() => {
      records.forEach((record, index) => {
        const dropped = excludedBy(record, manifest.exclude);
        if (dropped) {
          // Reported, not swallowed: an exclusion the report does not mention
          // is a deletion, and the next person to read the numbers has no way
          // to know a row was ever there.
          result.excluded.push({ record: index, matched: dropped.equals, reason: dropped.reason });
          return;
        }

        const documentId = `${manifest.id}#${index}`;
        const idsByName = new Map<string, string>();
        let personalHere = false;

        for (const entity of manifest.entities) {
          const built = this.buildNode(record, entity, documentId, clearance, baseCompartments, manifest);
          if (!built) {
            // An entity the manifest declared optional is expected to be
            // missing from most records; reporting each absence would bury the
            // one record that really was malformed.
            if (!entity.optional) {
              result.skipped.push({ record: index, reason: `entity "${entity.name}" has no usable id or label` });
            }
            continue;
          }
          idsByName.set(entity.name, built.id);
          if (entity.personal) personalHere = true;
          if (!seenNodes.has(built.id)) {
            seenNodes.add(built.id);
            result.nodesCreated += 1;
          }
        }

        // A record that produced nothing is not an ingested record, whatever
        // else happened to it.
        if (idsByName.size === 0) return;

        for (const edge of manifest.edges) {
          const from = idsByName.get(edge.from);
          const to = idsByName.get(edge.to);
          if (!from || !to || from === to) continue;
          const personalEdge =
            manifest.entities.find((e) => e.name === edge.from)?.personal === true ||
            manifest.entities.find((e) => e.name === edge.to)?.personal === true;

          try {
            this.graph.upsertEdge({
              source: from,
              target: to,
              relation: edge.relation,
              properties: {
                ...collectProperties(record, edge.properties),
                provenance_source: manifest.id,
                provenance_manifest_version: manifest.version,
              },
              clearance: personalEdge ? this.personalClearance(clearance) : clearance,
              compartments: personalEdge ? this.personalCompartments(baseCompartments) : baseCompartments,
              sourceDocId: documentId,
              ...validity(record, edge.validFrom, edge.validTo),
            });
            result.edgesCreated += 1;
          } catch (err) {
            // An ontology rejection loses its edge, never the batch: the same
            // catch-and-continue precedent as every other connector here.
            result.rejected.push({
              edge: `${from}-[${edge.relation}]->${to}`,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const text = this.buildText(record, manifest);
        if (text) {
          const doc: IndexedDocument = {
            id: documentId,
            text,
            source: manifest.id,
            sector: options.sector ?? manifest.sector,
            // Searchable text naming people carries the personal marking, not
            // the feed's: the index is a way to reach the same facts.
            clearance: personalHere ? this.personalClearance(clearance) : clearance,
            ...(personalHere
              ? { compartments: this.personalCompartments(baseCompartments) }
              : baseCompartments.length
                ? { compartments: [...baseCompartments] }
                : {}),
          };
          this.vectors.addDocument(doc);
          result.documents.push(doc);
        }

        result.recordsIngested += 1;
      });
    });

    this.audit.append('declarative-connector', 'ingest_source', {
      source: manifest.id,
      manifestVersion: manifest.version,
      clearance,
      compartments: baseCompartments,
      recordsRead: result.recordsRead,
      recordsIngested: result.recordsIngested,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      skipped: result.skipped.length,
      excluded: result.excluded.length,
      rejected: result.rejected.length,
    });

    return result;
  }

  /**
   * Personal data is not open data, wherever it arrives from.
   *
   * A feed that declares an entity as personal gets at least INTERNAL and the
   * personal-data compartment, regardless of what the manifest asked for. The
   * decision belongs to the platform rather than to whoever writes a mapping,
   * because a mapping author is exactly the person most likely to be thinking
   * about the feed and not about who ends up able to read its people.
   */
  private personalClearance(base: ClearanceLevel): ClearanceLevel {
    return Math.max(base, ClearanceLevel.INTERNAL) as ClearanceLevel;
  }

  private personalCompartments(base: readonly string[]): string[] {
    // Applied even when the caller does not hold the compartment themselves.
    // Refusing to mark because the ingester is outside the circle would
    // publish the people instead, and that is the wrong direction to fail.
    return unionCompartments([base, [PERSONAL_DATA_COMPARTMENT]]);
  }

  private buildNode(
    record: unknown,
    entity: EntityMapping,
    documentId: string,
    clearance: ClearanceLevel,
    compartments: string[],
    manifest: SourceManifest,
  ): { id: string } | null {
    const rawId = resolve(record, entity.id);
    if (rawId === null || String(rawId).trim() === '') return null;
    const id = `${entity.id.prefix ?? ''}${String(rawId).trim()}`;

    const label = resolve(record, entity.label);
    const text = label === null ? '' : String(label).trim();
    // A node with an id and no label is a node nobody can recognise in a
    // result list, so the record is reported rather than half-written.
    if (!text) return null;

    this.graph.upsertNode({
      id,
      type: entity.type,
      label: text,
      properties: {
        ...collectProperties(record, entity.properties),
        provenance_source: manifest.id,
        provenance_manifest_version: manifest.version,
      },
      clearance: entity.personal ? this.personalClearance(clearance) : clearance,
      compartments: entity.personal
        ? unionCompartments([compartments, [PERSONAL_DATA_COMPARTMENT]])
        : compartments,
      sourceDocId: documentId,
      ...validity(record, entity.validFrom, entity.validTo),
    });

    return { id };
  }

  private buildText(record: unknown, manifest: SourceManifest): string {
    if (manifest.text && manifest.text.length > 0) {
      return manifest.text
        .map((field) => resolve(record, field))
        .filter((value) => value !== null && String(value).trim() !== '')
        .join(' — ');
    }
    // With nothing declared, the labels are the searchable text: a feed whose
    // entities cannot be found by name has been ingested into a hole.
    return manifest.entities
      .map((entity) => resolve(record, entity.label))
      .filter((value) => value !== null && String(value).trim() !== '')
      .join(' — ');
  }
}
