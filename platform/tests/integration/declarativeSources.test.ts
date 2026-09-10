import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { SourceRegistry } from '../../core/ingestion/declarative/SourceRegistry';
import { DeclarativeConnector } from '../../core/ingestion/declarative/DeclarativeConnector';
import { ManifestError, parseSourceManifest } from '../../core/ingestion/declarative/SourceManifest';
import { PERSONAL_DATA_COMPARTMENT } from '../../core/ingestion/EdrConnector';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';
import { Principal } from '../../core/security/ApiKeyAuth';

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'config');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'wikidata-power-plants.json');

const principal = (clearance: ClearanceLevel, compartments: string[] = []): Principal => ({
  id: 'tester',
  clearance,
  compartments,
  purposes: [],
});

describe('declarative sources', () => {
  let dir: string;
  let ontology: OntologyManifest;
  let graph: GraphStore;
  let vectors: VectorIndex;
  let audit: AuditLog;
  let registry: SourceRegistry;
  let connector: DeclarativeConnector;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-'));
    ontology = OntologyManifest.fromFile(path.join(CONFIG, 'ontology.json'));
    graph = new GraphStore(path.join(dir, 'graph.json'), ontology);
    vectors = new VectorIndex();
    audit = new AuditLog(path.join(dir, 'audit.log'));
    registry = new SourceRegistry(ontology, audit);
    connector = new DeclarativeConnector(graph, vectors, audit);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const shipped = () => registry.loadDirectory(path.join(CONFIG, 'sources'));
  const payload = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  const ingest = (id: string, who = principal(ClearanceLevel.SECRET)) =>
    connector.ingest(registry.get(id)!, payload(), {
      callerClearance: who.clearance,
      callerCompartments: who.compartments,
    });

  describe('the manifests this deployment ships', () => {
    it('all load and validate against the ontology', () => {
      // A manifest naming a relation the ontology does not declare fails in
      // front of its author, not per-row at three in the morning.
      const { loaded, failed } = shipped();
      expect(failed).toEqual([]);
      expect(loaded.length).toBeGreaterThan(0);
    });

    it('each says what it is for', () => {
      shipped();
      for (const manifest of registry.list()) {
        // Read by whoever decides whether this feed should be writing to their
        // graph at all.
        expect(manifest.description.length).toBeGreaterThan(60);
        expect(manifest.entities.length).toBeGreaterThan(0);
      }
    });
  });

  describe('running one against the feed it was written for', () => {
    beforeEach(() => shipped());

    it('maps real records without a single rejection', () => {
      const result = ingest('wikidata-power-plants');
      expect(result.recordsRead).toBeGreaterThan(0);
      expect(result.recordsIngested).toBe(result.recordsRead);
      expect(result.rejected).toEqual([]);
      expect(result.nodesCreated).toBeGreaterThan(0);
    });

    it('pulls a number out of a string field, and a coordinate out of WKT', () => {
      ingest('wikidata-power-plants');
      const withCapacity = graph
        .findByType('Asset')
        .filter((n) => typeof n.properties.capacity_mw === 'number');
      expect(withCapacity.length).toBeGreaterThan(0);

      const located = graph.findByType('Asset').find((n) => typeof n.properties.lat === 'number')!;
      // Longitude comes first in WKT, which is the trap in every WKT parser.
      expect(located.properties.lat).toBeGreaterThan(40);
      expect(located.properties.lat).toBeLessThan(56);
      expect(located.properties.lon).toBeGreaterThan(20);
      expect(located.properties.lon).toBeLessThan(45);
    });

    it('writes an edge only for the records that have both ends', () => {
      // Wikidata names an operator for 7 of 244 plants. The rest are not
      // faults, and reporting each as skipped would bury the record that is.
      const result = ingest('wikidata-power-plants');
      expect(result.skipped).toEqual([]);
      expect(result.edgesCreated).toBeGreaterThan(0);
      expect(result.edgesCreated).toBeLessThan(result.recordsRead);

      const operated = graph.toJSON().edges.filter((e) => e.relation === 'OPERATED_BY');
      expect(operated.length).toBe(result.edgesCreated);
    });

    it('stamps provenance on everything, with the manifest version', () => {
      // There is no way to write an unattributed fact: the framework does it,
      // not the manifest author.
      ingest('wikidata-power-plants');
      const { nodes, edges } = graph.toJSON();
      for (const record of [...nodes, ...edges]) {
        expect(record.properties.provenance_source).toBe('wikidata-power-plants');
        expect(typeof record.properties.provenance_manifest_version).toBe('number');
      }
      expect(nodes[0].source_doc_ids[0]).toMatch(/^wikidata-power-plants#\d+$/);
    });

    it('makes the records findable by name', () => {
      ingest('wikidata-power-plants');
      const label = graph.findByType('Asset')[0].label;
      const word = label.split(/\s+/).find((w) => w.length > 4)!;
      expect(vectors.search(word, ClearanceLevel.SECRET, 3).length).toBeGreaterThan(0);
    });
  });

  describe('what the framework will not let a manifest do', () => {
    it('classify above the caller', () => {
      shipped();
      const manifest = parseSourceManifest(
        { ...registry.get('wikidata-power-plants')!, id: 'high', defaultClearance: 'SECRET' },
        ontology,
      );
      const result = connector.ingest(manifest, payload(), {
        callerClearance: ClearanceLevel.INTERNAL,
        callerCompartments: [],
      });
      expect(result.nodesCreated).toBeGreaterThan(0);
      // Every node it wrote — plants and their operators alike — is readable at
      // the caller's level, so nothing was written at the manifest's higher one.
      expect(graph.toJSON(ClearanceLevel.INTERNAL).nodes).toHaveLength(result.nodesCreated);
    });

    it('mark into a circle its ingester is outside', () => {
      const manifest = parseSourceManifest(
        {
          id: 'circled',
          title: 'x',
          description: 'A feed that asks for a compartment the ingester does not hold, at length.',
          sector: 'energy',
          recordsAt: 'results.bindings',
          compartments: ['grid'],
          entities: [
            {
              name: 'plant',
              type: 'Asset',
              id: { from: 'item.value', transform: ['last_path_segment'] },
              label: { from: 'itemLabel.value' },
            },
          ],
          edges: [],
        },
        ontology,
      );
      connector.ingest(manifest, payload(), { callerClearance: ClearanceLevel.SECRET, callerCompartments: [] });
      // Marking into a circle the ingester is outside would write facts they
      // could never read back to check, so the marking is dropped, not forced.
      expect(graph.findByType('Asset', ClearanceLevel.SECRET).length).toBeGreaterThan(0);
    });

    it('name a relation the ontology does not declare', () => {
      expect(() =>
        parseSourceManifest(
          {
            id: 'bad-edge',
            title: 'x',
            description: 'A manifest naming a relation nobody declared, described at sufficient length.',
            sector: 'energy',
            entities: [
              { name: 'a', type: 'Asset', id: { from: 'id' }, label: { from: 'name' } },
              { name: 'b', type: 'Asset', id: { from: 'id2' }, label: { from: 'name2' } },
            ],
            edges: [{ relation: 'TELEPATHICALLY_LINKED', from: 'a', to: 'b' }],
          },
          ontology,
        ),
      ).toThrow(/not declared in the ontology manifest/);
    });

    it('connect entity types a declared relation does not permit', () => {
      expect(() =>
        parseSourceManifest(
          {
            id: 'wrong-ends',
            title: 'x',
            description: 'A manifest using a real relation between the wrong kinds of thing, at length.',
            sector: 'energy',
            entities: [
              { name: 'a', type: 'Location', id: { from: 'id' }, label: { from: 'name' } },
              { name: 'b', type: 'Location', id: { from: 'id2' }, label: { from: 'name2' } },
            ],
            edges: [{ relation: 'SUPPLIES_POWER', from: 'a', to: 'b' }],
          },
          ontology,
        ),
      ).toThrow(/does not permit/);
    });

    it('run code — the transform set is closed', () => {
      // A mapping that can compute anything is a program running with the
      // ingestion's rights, and the whole value here is that it is a document.
      expect(() =>
        parseSourceManifest(
          {
            id: 'sneaky',
            title: 'x',
            description: 'A manifest trying to name a transform that does not exist, described at length.',
            sector: 'energy',
            entities: [
              { name: 'a', type: 'Asset', id: { from: 'id', transform: ['eval'] }, label: { from: 'name' } },
            ],
            edges: [],
          },
          ontology,
        ),
      ).toThrow(/is not a transform/);
    });

    it('leave out what an operator needs to review it', () => {
      expect(() =>
        parseSourceManifest({ id: 'terse', title: 'x', sector: 'energy', entities: [], edges: [] }, ontology),
      ).toThrow(/description is required/);
    });

    it('say both "from" and "const" and leave the reader guessing', () => {
      expect(() =>
        parseSourceManifest(
          {
            id: 'ambiguous',
            title: 'x',
            description: 'A manifest declaring a field two ways at once, described at sufficient length.',
            sector: 'energy',
            entities: [
              {
                name: 'a',
                type: 'Asset',
                id: { from: 'id' },
                label: { from: 'name', const: 'fixed' },
              },
            ],
            edges: [],
          },
          ontology,
        ),
      ).toThrow(/pick one/);
    });
  });

  describe('personal data, wherever it arrives from', () => {
    const peopleManifest = {
      id: 'people-feed',
      title: 'x',
      description: 'A feed carrying named individuals, declared as such, described at sufficient length.',
      sector: 'registry',
      recordsAt: 'rows',
      defaultClearance: 'PUBLIC',
      entities: [
        {
          name: 'person',
          type: 'Person',
          personal: true,
          id: { from: 'code', prefix: 'person:feed:' },
          label: { from: 'name' },
        },
      ],
      edges: [],
    };

    it('is marked by the platform, not by whoever wrote the mapping', () => {
      // A mapping author is exactly the person thinking about the feed and not
      // about who ends up able to read its people.
      const manifest = parseSourceManifest(peopleManifest, ontology);
      connector.ingest(manifest, { rows: [{ code: '1', name: 'Іваненко Іван' }] }, {
        callerClearance: ClearanceLevel.SECRET,
        callerCompartments: [],
      });

      expect(graph.findByType('Person', viewer(ClearanceLevel.TOP_SECRET, []))).toHaveLength(0);
      expect(
        graph.findByType('Person', viewer(ClearanceLevel.INTERNAL, [PERSONAL_DATA_COMPARTMENT])),
      ).toHaveLength(1);
    });

    it('keeps the searchable text behind the same marking', () => {
      const manifest = parseSourceManifest(peopleManifest, ontology);
      connector.ingest(manifest, { rows: [{ code: '1', name: 'Іваненко Іван' }] }, {
        callerClearance: ClearanceLevel.SECRET,
        callerCompartments: [],
      });
      expect(vectors.search('Іваненко', viewer(ClearanceLevel.TOP_SECRET, []), 5)).toHaveLength(0);
      expect(
        vectors.search('Іваненко', viewer(ClearanceLevel.INTERNAL, [PERSONAL_DATA_COMPARTMENT]), 5).length,
      ).toBe(1);
    });
  });

  describe('registering one at runtime', () => {
    const minimal = {
      id: 'runtime-feed',
      title: 'x',
      description: 'A perfectly ordinary feed registered at runtime, described at sufficient length.',
      sector: 'energy',
      entities: [{ name: 'a', type: 'Asset', id: { from: 'id' }, label: { from: 'name' } }],
      edges: [],
    };

    it('is a privileged act, because a manifest decides what a feed writes', () => {
      expect(() => registry.register(minimal, principal(ClearanceLevel.INTERNAL))).toThrow(/CONFIDENTIAL/);
      expect(registry.register(minimal, principal(ClearanceLevel.CONFIDENTIAL)).manifest.id).toBe('runtime-feed');
    });

    it('replaces by id and records what it replaced', () => {
      // A feed's mapping decides what its data means, so changing one changes
      // the interpretation of everything it wrote before.
      registry.register(minimal, principal(ClearanceLevel.CONFIDENTIAL));
      const second = registry.register({ ...minimal, version: 2 }, principal(ClearanceLevel.CONFIDENTIAL));
      expect(second.replaced?.version).toBe(1);

      const entry = audit.all().find((e) => e.action === 'source_replaced')!;
      expect((entry.details as { previousVersion: number }).previousVersion).toBe(1);
    });

    it('cannot be classified above the person registering it', () => {
      expect(() =>
        registry.register({ ...minimal, defaultClearance: 'TOP_SECRET' }, principal(ClearanceLevel.CONFIDENTIAL)),
      ).toThrow(/above the person/);
    });
  });

  describe('a payload that is not what the manifest expects', () => {
    beforeEach(() => shipped());

    it('says where it looked, rather than ingesting nothing quietly', () => {
      expect(() =>
        connector.ingest(registry.get('wikidata-power-plants')!, { unexpected: true }, {
          callerClearance: ClearanceLevel.SECRET,
          callerCompartments: [],
        }),
      ).toThrow(/results\.bindings/);
    });
  });
});
