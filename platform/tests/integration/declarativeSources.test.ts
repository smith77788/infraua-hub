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
import { SourceFetcher, parseFetchPolicy } from '../../core/ingestion/declarative/SourceFetcher';
import { PERSONAL_DATA_COMPARTMENT } from '../../core/ingestion/EdrConnector';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';
import { Principal } from '../../core/security/ApiKeyAuth';

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'config');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'wikidata-power-plants.json');
const SETTLEMENTS = path.join(__dirname, '..', 'fixtures', 'wikidata-settlements.json');

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
  let infraAllowed = true;
  let connector: DeclarativeConnector;

  beforeEach(() => {
    // Shipped feeds include critical-infrastructure ones, which a deployment
    // has to turn on. On here so the mapping itself stays under test; the gate
    // has its own tests below.
    infraAllowed = true;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-'));
    ontology = OntologyManifest.fromFile(path.join(CONFIG, 'ontology.json'));
    graph = new GraphStore(path.join(dir, 'graph.json'), ontology);
    vectors = new VectorIndex();
    audit = new AuditLog(path.join(dir, 'audit.log'));
    // Четвертий аргумент — предикат вимикача. Тут відкритий, бо перевіряється
    // відображення; сам вимикач має власні тести нижче.
    registry = new SourceRegistry(ontology, audit, undefined, () => infraAllowed);
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

  describe('settlements, where the arithmetic is the whole point', () => {
    const settlements = () => JSON.parse(fs.readFileSync(SETTLEMENTS, 'utf-8'));
    const ingestSettlements = () =>
      connector.ingest(registry.get('wikidata-settlements')!, settlements(), {
        callerClearance: ClearanceLevel.SECRET,
        callerCompartments: [],
      });

    beforeEach(() => shipped());

    it('drops the agglomeration by name, and says why in the report', () => {
      const result = ingestSettlements();
      expect(result.excluded).toHaveLength(1);
      expect(result.excluded[0].matched).toContain('Q4166179');
      // The reason is the difference between an exclusion and a deletion.
      expect(result.excluded[0].reason).toMatch(/агломерація/);
      expect(graph.findByType('Location').some((n) => n.label === 'Великий Донецьк')).toBe(false);
    });

    it('counts a settlement once even when the source gives it two coordinates', () => {
      // Феодосія appears twice in the real answer with coordinates that differ
      // in the fourth decimal. Summing rows would count its people twice;
      // identity comes from the Wikidata id, so the graph holds one node.
      const rows = settlements().results.bindings as { placeLabel: { value: string } }[];
      expect(rows.filter((r) => r.placeLabel.value === 'Феодосія')).toHaveLength(2);

      ingestSettlements();
      expect(graph.findByType('Location').filter((n) => n.label === 'Феодосія')).toHaveLength(1);
    });

    it('carries population as a number, not as the string the endpoint sent', () => {
      ingestSettlements();
      const kyiv = graph.findByType('Location').find((n) => n.label === 'Київ')!;
      expect(kyiv.properties.population).toBe(2952301);
      expect(kyiv.properties.lat).toBeCloseTo(50.45, 5);
      expect(kyiv.properties.lon).toBeCloseTo(30.5236, 3);
    });

    it('sums to the people actually in the fixture, agglomeration excluded', () => {
      ingestSettlements();
      const total = graph
        .findByType('Location')
        .reduce((sum, n) => sum + (typeof n.properties.population === 'number' ? n.properties.population : 0), 0);
      // Everything in the fixture except Великий Донецьк, and Феодосія once.
      expect(total).toBe(2952301 + 1421125 + 52237 + 25030 + 66293 + 2995 + 2985);
    });
  });

  describe('an exclusion', () => {
    const withExclude = (rule: Record<string, unknown>) => ({
      id: 'exclusion-test',
      title: 'T',
      description: 'A feed with one row it does not want.',
      sector: 'test',
      entities: [{ name: 'a', type: 'Location', id: { from: 'id' }, label: { from: 'name' } }],
      edges: [],
      exclude: [rule],
    });

    it('must say why, or it is a deletion', () => {
      expect(() => parseSourceManifest(withExclude({ from: 'id', equals: 'x' }))).toThrow(/reason is required/);
    });

    it('matches a numeric id and its string form alike', () => {
      const manifest = parseSourceManifest(withExclude({ from: 'id', equals: '7', reason: 'known bad row' }));
      const result = connector.ingest(manifest, [{ id: 7, name: 'dropped' }, { id: 8, name: 'kept' }], {
        callerClearance: ClearanceLevel.SECRET,
        callerCompartments: [],
      });
      expect(result.excluded).toHaveLength(1);
      expect(result.recordsIngested).toBe(1);
    });
  });

  describe('a manifest that says where its records come from', () => {
    const policy = () =>
      parseFetchPolicy({ outbound_fetch: { allowed_hosts: ['query.wikidata.org'], timeout_ms: 1000 } });

    const answering = (body: string, status = 200) => {
      const calls: { url: string; init: Record<string, unknown> }[] = [];
      const fake = async (url: string, init: Record<string, unknown>) => {
        calls.push({ url, init });
        return { ok: status >= 200 && status < 300, status, text: async () => body };
      };
      return { calls, fake };
    };

    beforeEach(() => shipped());

    it('puts the query in the URL, so what was called is checkable afterwards', async () => {
      const { calls, fake } = answering(fs.readFileSync(SETTLEMENTS, 'utf-8'));
      const fetcher = new SourceFetcher(policy(), audit, fake);
      const pulled = await fetcher.fetch(registry.get('wikidata-settlements')!, 'tester');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('query.wikidata.org');
      expect(decodeURIComponent(calls[0].url)).toContain('wdt:P1082');
      expect(pulled.status).toBe(200);

      const entry = audit.all().find((e) => e.action === 'fetch_source')!;
      expect((entry.details as { url: string }).url).toBe(pulled.url);
    });

    it('never contacts a host the deployment did not allow', async () => {
      const { calls, fake } = answering('{}');
      const empty = parseFetchPolicy({ outbound_fetch: { allowed_hosts: [] } });
      const fetcher = new SourceFetcher(empty, audit, fake);

      await expect(fetcher.fetch(registry.get('wikidata-settlements')!, 'tester')).rejects.toThrow(/allowlist/);
      // Refused before the request, so nothing about the answer can change it.
      expect(calls).toHaveLength(0);
    });

    it('defaults to allowing nothing', () => {
      expect(parseFetchPolicy({}).allowedHosts).toEqual([]);
    });

    it('reports an upstream error as an upstream error', async () => {
      const { fake } = answering('rate limited', 429);
      const fetcher = new SourceFetcher(policy(), audit, fake);
      await expect(fetcher.fetch(registry.get('wikidata-settlements')!, 'tester')).rejects.toThrow(/HTTP 429/);
    });

    it('refuses a body that is not JSON rather than ingesting nothing', async () => {
      const { fake } = answering('<html>504</html>');
      const fetcher = new SourceFetcher(policy(), audit, fake);
      await expect(fetcher.fetch(registry.get('wikidata-settlements')!, 'tester')).rejects.toThrow(/did not answer with JSON/);
    });

    it('will not carry a credential, because a manifest is a reviewed document', () => {
      const base = {
        id: 'fetch-test',
        title: 'T',
        description: 'A feed that tries to authenticate itself.',
        sector: 'test',
        entities: [{ name: 'a', type: 'Location', id: { from: 'id' }, label: { from: 'name' } }],
        edges: [],
      };
      expect(() =>
        parseSourceManifest({ ...base, fetch: { url: 'https://example.org/x', headers: { Authorization: 'Bearer x' } } }),
      ).toThrow(/not an identity/);
      expect(() => parseSourceManifest({ ...base, fetch: { url: 'https://u:p@example.org/x' } })).toThrow(/credentials/);
      expect(() => parseSourceManifest({ ...base, fetch: { url: 'http://example.org/x' } })).toThrow(/https/);
    });

    it('is rejected at registration when it names a host this deployment will not call', () => {
      const guarded = new SourceRegistry(ontology, audit, policy());
      expect(() =>
        guarded.register(
          {
            id: 'elsewhere',
            title: 'T',
            description: 'A feed pointing somewhere the deployment does not allow.',
            sector: 'test',
            entities: [{ name: 'a', type: 'Location', id: { from: 'id' }, label: { from: 'name' } }],
            edges: [],
            fetch: { url: 'https://example.org/data.json' },
          },
          principal(ClearanceLevel.SECRET),
        ),
      ).toThrow(/allowlist/);
    });
  });


  describe('feeds that write critical-infrastructure objects', () => {
    it('are declared by the manifest, so a reviewer sees what it carries', () => {
      shipped();
      expect(registry.get('wikidata-power-plants')!.criticalInfrastructure).toBe(true);
      expect(registry.get('wikidata-dams')!.criticalInfrastructure).toBe(true);
      // Population is not infrastructure, and conflating them would take the
      // consequence data down with the targets.
      expect(registry.get('wikidata-settlements')!.criticalInfrastructure).toBeUndefined();
    });

    it('disappear from the catalogue the moment the switch closes, without a restart', () => {
      shipped();
      expect(registry.list().map((m) => m.id)).toContain('wikidata-power-plants');

      // The switch is turned at runtime, from a phone. A registry that decided
      // this at load time would need a restart per turn of the handle.
      infraAllowed = false;
      expect(registry.list().map((m) => m.id)).toEqual(['wikidata-settlements']);
      expect(registry.get('wikidata-power-plants')).toBeUndefined();
      expect(registry.hiddenCount()).toBe(2);

      infraAllowed = true;
      expect(registry.get('wikidata-power-plants')).toBeDefined();
    });

    it('stay findable for the purge, which must reach what the switch hid', () => {
      shipped();
      infraAllowed = false;
      // Otherwise turning the switch off would hide the very batches somebody
      // is trying to remove from the graph.
      expect(registry.all().map((m) => m.id)).toContain('wikidata-power-plants');
    });

    it('cannot be registered while the switch is closed, whatever the clearance', () => {
      infraAllowed = false;
      expect(() =>
        registry.register(
          {
            id: 'substations',
            title: 'T',
            description: 'A feed of substations somebody wants to add anyway.',
            sector: 'energy',
            criticalInfrastructure: true,
            entities: [{ name: 'a', type: 'Asset', id: { from: 'id' }, label: { from: 'name' } }],
            edges: [],
          },
          principal(ClearanceLevel.TOP_SECRET),
        ),
      ).toThrow(/does not ingest/);
    });
  });

});
