import { GraphStore } from '../graph/GraphStore';
import { VectorIndex, IndexedDocument } from '../vector/VectorIndex';
import { AuditLog } from '../audit/AuditLog';
import { ClearanceLevel } from '../security/Clearance';
import { slugify } from './IngestionService';

/**
 * Brings the InfraUA picture into the platform graph.
 *
 * InfraUA and Palanter are one product: InfraUA is where the critical
 * infrastructure of a country is observed, Palanter is where assertions are
 * held, classified and audited. Until now they shared nothing but intent -
 * the console computed its own graph in the browser and threw it away on
 * reload, and none of it was ever subject to ontology validation, clearance
 * or the audit chain.
 *
 * The mapping needs no new node types. Facilities are Assets, their operators
 * Organizations, natural events Events; the three relations this uses
 * (SUPPLIES_POWER, OPERATED_BY, THREATENS) were added to config/ontology.json
 * and to nothing else, which is what the config-driven manifest exists for.
 *
 * ## Provenance crosses the boundary
 *
 * This is the point of the whole exercise. InfraUA distinguishes what it
 * observed from what it inferred, edge by edge. That distinction is carried
 * onto the graph edges rather than flattened on the way in, so a question
 * asked of the platform ("what does this substation feed") can still be
 * answered with "these three are real 330 kV lines from OSM, that one is our
 * nearest-neighbour guess" - and the audit log records which kind of claim an
 * analyst acted on.
 *
 * ## What is deliberately not ingested
 *
 * Criticality scores and contingency rankings stay out. They are derived from
 * the graph and recomputed from it; writing a snapshot of yesterday's ranking
 * into the store as though it were a fact is precisely the observed/inferred
 * confusion the provenance work exists to prevent. Derived knowledge belongs
 * to the analysis layer, which can recompute it at any time from what is here.
 */

/** Provenance as InfraUA states it, mirrored rather than re-derived. */
export type InfraUAProvenance =
  | {
      kind: 'observed';
      source: string;
      ref?: string;
      retrievedAt?: string;
      attributes?: Record<string, string | number>;
    }
  | {
      kind: 'inferred';
      method: string;
      params?: Record<string, string | number>;
      confidence: number;
      caveat?: string;
    };

export interface InfraUAFacility {
  id: string;
  name: string;
  /** InfraUA category id, e.g. "substation", "hospital". */
  category: string;
  lat: number;
  lon: number;
  operator?: string;
  detail?: string;
  /** Source URL or dataset name. */
  source: string;
}

export interface InfraUAEvent {
  id: string;
  title: string;
  kind: string;
  lat: number;
  lon: number;
  time: string;
  magnitude?: number;
  url?: string;
  source: string;
  /** Facility ids this event was found to endanger. */
  threatens?: string[];
}

export interface InfraUADependency {
  /** Facility id that supplies. */
  from: string;
  /** Facility id that is supplied. */
  to: string;
  km: number;
  kind: string;
  provenance: InfraUAProvenance;
}

export interface InfraUAPayload {
  facilities?: InfraUAFacility[];
  events?: InfraUAEvent[];
  dependencies?: InfraUADependency[];
  /** When the console assembled this picture. */
  retrievedAt?: string;
}

export interface InfraUAIngestResult {
  facilitiesIngested: number;
  organizationsIngested: number;
  eventsIngested: number;
  dependenciesIngested: number;
  /** Edges the ontology refused, with the reason - never silently dropped. */
  rejected: { edge: string; reason: string }[];
  /** Referenced facility ids that were not in this payload. */
  danglingReferences: string[];
  observedDependencies: number;
  inferredDependencies: number;
  documents: IndexedDocument[];
}

const FACILITY_PREFIX = 'infraua_facility';
const ORG_PREFIX = 'infraua_org';
const EVENT_PREFIX = 'infraua_event';

function facilityNodeId(id: string): string {
  return slugify(`${FACILITY_PREFIX}_${id}`);
}

function orgNodeId(operator: string): string {
  return slugify(`${ORG_PREFIX}_${operator}`);
}

function eventNodeId(id: string): string {
  return slugify(`${EVENT_PREFIX}_${id}`);
}

/**
 * Flattens provenance onto edge properties.
 *
 * Kept as a prefixed flat shape rather than a nested object because graph
 * properties are queried and filtered by key; `provenance_kind = "inferred"`
 * is a question the store can answer, `provenance = {...}` is not.
 */
function provenanceProperties(p: InfraUAProvenance): Record<string, unknown> {
  if (p.kind === 'observed') {
    const out: Record<string, unknown> = {
      provenance_kind: 'observed',
      provenance_source: p.source,
      // Observed facts are taken at face value; that is what observed means.
      provenance_confidence: 1,
    };
    if (p.ref !== undefined) out.provenance_ref = p.ref;
    if (p.retrievedAt !== undefined) out.provenance_retrieved_at = p.retrievedAt;
    for (const [key, value] of Object.entries(p.attributes ?? {})) out[key] = value;
    return out;
  }
  const out: Record<string, unknown> = {
    provenance_kind: 'inferred',
    provenance_method: p.method,
    provenance_confidence: p.confidence,
  };
  if (p.caveat !== undefined) out.provenance_caveat = p.caveat;
  for (const [key, value] of Object.entries(p.params ?? {})) out[`param_${key}`] = value;
  return out;
}

export class InfraUAConnector {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorIndex,
    private readonly audit: AuditLog
  ) {}

  /**
   * `clearance` classifies everything in this batch.
   *
   * PUBLIC is the honest default: OpenStreetMap, NASA and USGS are open data,
   * and marking open data as restricted would make the whole classification
   * model meaningless. It is a parameter rather than a constant because the
   * aggregate is not the inputs - a ranked answer to "which single failure
   * costs the most hospitals" is a different object from the public facts it
   * was computed from, and an operator deploying this somewhere that cares
   * must be able to classify the feed accordingly.
   */
  ingest(
    payload: InfraUAPayload,
    source: string,
    sector: string,
    clearance: ClearanceLevel = ClearanceLevel.PUBLIC,
    /**
     * Need-to-know compartments applied to everything this batch writes
     * (core/security/Marking.ts). An open feed carries none; a feed whose
     * assembled picture belongs to one circle names that circle here, and the
     * marking travels with every node, edge and document it produces.
     */
    compartments: readonly string[] = []
  ): InfraUAIngestResult {
    if (!payload || typeof payload !== 'object') {
      throw new Error('payload must be an object');
    }

    const facilities = payload.facilities ?? [];
    const events = payload.events ?? [];
    const dependencies = payload.dependencies ?? [];

    const result: InfraUAIngestResult = {
      facilitiesIngested: 0,
      organizationsIngested: 0,
      eventsIngested: 0,
      dependenciesIngested: 0,
      rejected: [],
      danglingReferences: [],
      observedDependencies: 0,
      inferredDependencies: 0,
      documents: [],
    };

    const knownFacilities = new Set<string>();
    const seenOrgs = new Set<string>();
    const dangling = new Set<string>();

    this.graph.runBatch(() => {
      for (const facility of facilities) {
        if (!facility?.id || !facility.name) continue;
        const documentId = `${source}#facility:${facility.id}`;
        const nodeId = facilityNodeId(facility.id);

        const properties: Record<string, unknown> = {
          type: facility.category,
          lat: facility.lat,
          lon: facility.lon,
          // Every facility here is something a public dataset actually
          // records; nothing in this branch is inferred.
          provenance_kind: 'observed',
          provenance_source: facility.source,
        };
        if (facility.detail !== undefined) properties.detail = facility.detail;
        if (facility.operator !== undefined) properties.operator = facility.operator;

        this.graph.upsertNode({
          id: nodeId,
          type: 'Asset',
          label: facility.name,
          properties,
          clearance,
          compartments,
          sourceDocId: documentId,
        });
        knownFacilities.add(facility.id);
        result.facilitiesIngested++;

        const operator = facility.operator?.trim();
        if (operator) {
          const organizationId = orgNodeId(operator);
          if (!seenOrgs.has(organizationId)) {
            this.graph.upsertNode({
              id: organizationId,
              type: 'Organization',
              label: operator,
              properties: { provenance_kind: 'observed', provenance_source: facility.source },
              clearance,
              compartments,
              sourceDocId: documentId,
            });
            seenOrgs.add(organizationId);
            result.organizationsIngested++;
          }
          this.safeEdge(
            { source: nodeId, target: organizationId, relation: 'OPERATED_BY', properties: {}, clearance, compartments, sourceDocId: documentId },
            result
          );
        }

        const text = [facility.name, facility.category, facility.operator, facility.detail]
          .filter(Boolean)
          .join(' · ');
        const doc: IndexedDocument = { id: documentId, text, source, sector, clearance, ...(compartments.length ? { compartments: [...compartments] } : {}) };
        this.vectors.addDocument(doc);
        result.documents.push(doc);
      }

      for (const event of events) {
        if (!event?.id || !event.title) continue;
        const documentId = `${source}#event:${event.id}`;
        const nodeId = eventNodeId(event.id);

        const properties: Record<string, unknown> = {
          timestamp: event.time,
          kind: event.kind,
          lat: event.lat,
          lon: event.lon,
          provenance_kind: 'observed',
          provenance_source: event.source,
        };
        if (event.magnitude !== undefined) properties.severity = event.magnitude;
        if (event.url !== undefined) properties.url = event.url;

        this.graph.upsertNode({
          id: nodeId,
          type: 'Event',
          label: event.title,
          properties,
          // An event is true in the world from when it happened, not from when
          // this feed reached us. Without that the grid cannot be
          // reconstructed for the moment of a strike - only for the moment the
          // report arrived, which is the wrong instant for every question
          // anyone asks afterwards.
          ...(typeof event.time === 'string' && event.time ? { validFrom: event.time } : {}),
          clearance,
          compartments,
          sourceDocId: documentId,
        });
        result.eventsIngested++;

        for (const facilityId of event.threatens ?? []) {
          if (!knownFacilities.has(facilityId)) {
            dangling.add(facilityId);
            continue;
          }
          this.safeEdge(
            {
              source: nodeId,
              target: facilityNodeId(facilityId),
              relation: 'THREATENS',
              // Proximity is measured, not assumed - but the radius is ours.
              properties: { provenance_kind: 'inferred', provenance_method: 'proximity radius' },
              clearance,
              compartments,
              sourceDocId: documentId,
            },
            result
          );
        }

        const doc: IndexedDocument = {
          id: documentId,
          text: `${event.title} (${event.kind})`,
          source,
          sector,
          clearance,
          ...(compartments.length ? { compartments: [...compartments] } : {}),
        };
        this.vectors.addDocument(doc);
        result.documents.push(doc);
      }

      for (const dependency of dependencies) {
        if (!dependency?.from || !dependency.to || !dependency.provenance) continue;
        if (!knownFacilities.has(dependency.from)) {
          dangling.add(dependency.from);
          continue;
        }
        if (!knownFacilities.has(dependency.to)) {
          dangling.add(dependency.to);
          continue;
        }

        const documentId = `${source}#dependency:${dependency.from}->${dependency.to}`;
        const created = this.safeEdge(
          {
            source: facilityNodeId(dependency.from),
            target: facilityNodeId(dependency.to),
            relation: 'SUPPLIES_POWER',
            properties: {
              km: dependency.km,
              supply_kind: dependency.kind,
              ...provenanceProperties(dependency.provenance),
            },
            clearance,
            compartments,
            sourceDocId: documentId,
          },
          result
        );
        if (!created) continue;
        result.dependenciesIngested++;
        if (dependency.provenance.kind === 'observed') result.observedDependencies++;
        else result.inferredDependencies++;
      }
    });

    result.danglingReferences = [...dangling];

    this.audit.append(source, 'INFRAUA_INGEST', {
      sector,
      clearance,
      compartments,
      retrievedAt: payload.retrievedAt ?? null,
      facilities: result.facilitiesIngested,
      organizations: result.organizationsIngested,
      events: result.eventsIngested,
      dependencies: result.dependenciesIngested,
      // The observed/inferred split is in the audit record on purpose: an
      // ingest that quietly went all-guesses is a fact about the batch.
      observed: result.observedDependencies,
      inferred: result.inferredDependencies,
      rejected: result.rejected.length,
      dangling: result.danglingReferences.length,
    });

    return result;
  }

  /** Ontology rejections are recorded with their reason, never swallowed. */
  private safeEdge(
    input: {
      source: string;
      target: string;
      relation: string;
      properties: Record<string, unknown>;
      clearance: ClearanceLevel;
      compartments?: readonly string[];
      sourceDocId: string;
    },
    result: InfraUAIngestResult
  ): boolean {
    try {
      this.graph.upsertEdge(input);
      return true;
    } catch (err) {
      result.rejected.push({
        edge: `${input.source}-[${input.relation}]->${input.target}`,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
