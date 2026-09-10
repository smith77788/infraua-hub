import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { ClearanceLevel } from '../../core/security/Clearance';
import { InfraUAConnector, InfraUAPayload } from '../../core/ingestion/InfraUAConnector';
import { describe, expect, it } from 'bun:test';

/** The real manifest, so a drift between config and connector fails here. */
const manifest = OntologyManifest.fromFile(
  path.join(__dirname, '..', '..', 'config', 'ontology.json'),
);

function makeConnector() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infraua-'));
  const graph = new GraphStore(undefined, manifest);
  const vectors = new VectorIndex();
  const audit = new AuditLog(path.join(dir, 'audit.jsonl'));
  return { graph, vectors, audit, connector: new InfraUAConnector(graph, vectors, audit) };
}

const PAYLOAD: InfraUAPayload = {
  retrievedAt: '2026-09-09T00:00:00.000Z',
  facilities: [
    {
      id: 'plant-1',
      name: 'ТЕС Приклад',
      category: 'power_plant',
      lat: 50.4,
      lon: 30.5,
      operator: 'ДТЕК',
      source: 'https://openstreetmap.org/way/1',
    },
    {
      id: 'sub-1',
      name: 'ПС Північна',
      category: 'substation',
      lat: 50.5,
      lon: 30.5,
      operator: 'Укренерго',
      source: 'https://openstreetmap.org/way/2',
    },
    {
      id: 'hosp-1',
      name: 'Лікарня №1',
      category: 'hospital',
      lat: 50.6,
      lon: 30.5,
      source: 'https://openstreetmap.org/way/3',
    },
  ],
  events: [
    {
      id: 'fire-1',
      title: 'Пожежа поблизу підстанції',
      kind: 'fire',
      lat: 50.5,
      lon: 30.51,
      time: '2026-09-08T12:00:00.000Z',
      source: 'NASA EONET',
      threatens: ['sub-1'],
    },
  ],
  dependencies: [
    {
      from: 'plant-1',
      to: 'sub-1',
      km: 11.1,
      kind: 'supply',
      provenance: {
        kind: 'observed',
        source: 'OpenStreetMap',
        ref: 'way/500',
        retrievedAt: '2026-09-09T00:00:00.000Z',
        attributes: { voltage: 330000 },
      },
    },
    {
      from: 'sub-1',
      to: 'hosp-1',
      km: 11.1,
      kind: 'feed',
      provenance: {
        kind: 'inferred',
        method: 'найближча підстанція',
        params: { radiusKm: 120 },
        confidence: 0.25,
        caveat: 'Розподільчої мережі в даних немає.',
      },
    },
  ],
};

describe('InfraUAConnector', () => {
  it('maps facilities, operators and events onto the existing five node types', () => {
    const { graph, connector } = makeConnector();
    const result = connector.ingest(PAYLOAD, 'infraua', 'infrastructure', ClearanceLevel.PUBLIC);

    expect(result.facilitiesIngested).toBe(3);
    expect(result.organizationsIngested).toBe(2);
    expect(result.eventsIngested).toBe(1);
    expect(result.rejected).toEqual([]);

    expect(graph.findByType('Asset').map((n) => n.label).sort()).toEqual([
      'Лікарня №1',
      'ПС Північна',
      'ТЕС Приклад',
    ]);
    expect(graph.findByType('Organization')).toHaveLength(2);
    expect(graph.findByType('Event')).toHaveLength(1);
  });

  it('carries the observed/inferred distinction onto the edge, not away from it', () => {
    // The whole reason the two products are being joined: an assertion in the
    // platform graph must still say whether anyone observed it.
    const { graph, connector } = makeConnector();
    connector.ingest(PAYLOAD, 'infraua', 'infrastructure');

    const edges = graph.toJSON().edges.filter((e) => e.relation === 'SUPPLIES_POWER');
    expect(edges).toHaveLength(2);

    const observed = edges.find((e) => e.properties.provenance_kind === 'observed')!;
    expect(observed.properties.provenance_source).toBe('OpenStreetMap');
    expect(observed.properties.provenance_ref).toBe('way/500');
    expect(observed.properties.voltage).toBe(330000);
    expect(observed.properties.provenance_confidence).toBe(1);

    const inferred = edges.find((e) => e.properties.provenance_kind === 'inferred')!;
    expect(inferred.properties.provenance_method).toBe('найближча підстанція');
    expect(inferred.properties.provenance_confidence).toBe(0.25);
    expect(inferred.properties.param_radiusKm).toBe(120);
    expect(inferred.properties.provenance_caveat).toContain('Розподільчої');
  });

  it('counts the observed and inferred split so an all-guess batch is visible', () => {
    const { connector } = makeConnector();
    const result = connector.ingest(PAYLOAD, 'infraua', 'infrastructure');
    expect(result.observedDependencies).toBe(1);
    expect(result.inferredDependencies).toBe(1);
  });

  it('records the ingest in the audit chain with the provenance split', () => {
    const { audit, connector } = makeConnector();
    connector.ingest(PAYLOAD, 'infraua', 'infrastructure');

    const entries = audit.all();
    const entry = entries[entries.length - 1];
    expect(entry.action).toBe('INFRAUA_INGEST');
    expect(entry.details).toMatchObject({ observed: 1, inferred: 1, facilities: 3 });
    expect(audit.verify().valid).toBe(true);
  });

  it('classifies the batch at the level it is given, and defaults to PUBLIC', () => {
    // Open data marked as restricted would make the whole clearance model
    // meaningless; a raised level must still be possible for the aggregate.
    const open = makeConnector();
    open.connector.ingest(PAYLOAD, 'infraua', 'infrastructure');
    expect(open.graph.findByType('Asset', ClearanceLevel.PUBLIC)).toHaveLength(3);

    const closed = makeConnector();
    closed.connector.ingest(PAYLOAD, 'infraua', 'infrastructure', ClearanceLevel.SECRET);
    expect(closed.graph.findByType('Asset', ClearanceLevel.PUBLIC)).toHaveLength(0);
    expect(closed.graph.findByType('Asset', ClearanceLevel.SECRET)).toHaveLength(3);
  });

  it('reports references to facilities the payload does not contain', () => {
    const { connector } = makeConnector();
    const result = connector.ingest(
      {
        facilities: [PAYLOAD.facilities![0]],
        dependencies: [
          {
            from: 'plant-1',
            to: 'nowhere',
            km: 5,
            kind: 'supply',
            provenance: { kind: 'observed', source: 'OSM' },
          },
        ],
      },
      'infraua',
      'infrastructure'
    );
    expect(result.dependenciesIngested).toBe(0);
    expect(result.danglingReferences).toEqual(['nowhere']);
  });

  it('is idempotent: the same picture ingested twice is the same graph', () => {
    // The console re-sends its whole picture; a second send must not double
    // the network.
    const { graph, connector } = makeConnector();
    connector.ingest(PAYLOAD, 'infraua', 'infrastructure');
    const first = graph.toJSON();
    connector.ingest(PAYLOAD, 'infraua', 'infrastructure');
    const second = graph.toJSON();

    expect(second.nodes).toHaveLength(first.nodes.length);
    expect(second.edges).toHaveLength(first.edges.length);
  });

  it('links a facility to its operator and an event to what it threatens', () => {
    const { graph, connector } = makeConnector();
    connector.ingest(PAYLOAD, 'infraua', 'infrastructure');
    const relations = graph.toJSON().edges.map((e) => e.relation);
    expect(relations).toContain('OPERATED_BY');
    expect(relations).toContain('THREATENS');
  });

  it('does not ingest derived criticality, only facts', () => {
    // Derived rankings are recomputed from the graph; storing a snapshot as a
    // fact is the observed/inferred confusion this whole design prevents.
    const { graph, connector } = makeConnector();
    connector.ingest(PAYLOAD, 'infraua', 'infrastructure');
    for (const node of graph.toJSON().nodes) {
      expect(node.properties).not.toHaveProperty('criticality_score');
      expect(node.properties).not.toHaveProperty('criticality_band');
    }
  });

  it('rejects an edge the ontology does not permit, with the reason', () => {
    // Guard against the connector being widened later without the manifest.
    expect(manifest.validateEdge('SUPPLIES_POWER', 'Asset', 'Organization').valid).toBe(false);
    expect(manifest.validateEdge('SUPPLIES_POWER', 'Asset', 'Asset').valid).toBe(true);
    expect(manifest.validateEdge('THREATENS', 'Event', 'Asset').valid).toBe(true);
    expect(manifest.validateEdge('OPERATED_BY', 'Asset', 'Organization').valid).toBe(true);
  });

  it('survives an empty payload without inventing anything', () => {
    const { graph, connector } = makeConnector();
    const result = connector.ingest({}, 'infraua', 'infrastructure');
    expect(result.facilitiesIngested).toBe(0);
    expect(graph.toJSON().nodes).toHaveLength(0);
  });
});
