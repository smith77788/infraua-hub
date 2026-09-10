import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { RiskScorer } from '../../core/analytics/RiskScorer';
import { ProzorroConnector, ProzorroTender } from '../../core/ingestion/ProzorroConnector';
import { ClearanceLevel } from '../../core/security/Clearance';

const CONFIG = path.join(__dirname, '..', '..', 'config');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'prozorro-tenders.json');

/**
 * Exercised against records taken from the live Prozorro API rather than a
 * shape invented here. A fixture I wrote myself would only ever test my
 * assumptions about the feed, and the assumptions are the part most likely to
 * be wrong.
 */
describe('Prozorro ingestion', () => {
  let dir: string;
  let graph: GraphStore;
  let vectors: VectorIndex;
  let audit: AuditLog;
  let connector: ProzorroConnector;
  let tenders: ProzorroTender[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prozorro-'));
    graph = new GraphStore(path.join(dir, 'graph.json'), OntologyManifest.fromFile(path.join(CONFIG, 'ontology.json')));
    vectors = new VectorIndex();
    audit = new AuditLog(path.join(dir, 'audit.log'));
    connector = new ProzorroConnector(graph, vectors, audit);
    tenders = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')).tenders;
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('maps real records into the ontology without a single rejection', () => {
    const result = connector.ingest(tenders, 'prozorro-test');
    expect(result.tendersIngested).toBe(tenders.length);
    expect(result.organizationsIngested).toBeGreaterThan(0);
    expect(result.awardsIngested).toBeGreaterThan(0);
    // A rejection here would mean the ontology and the feed disagree, which is
    // the thing this test exists to catch before a deployment does.
    expect(result.rejected).toEqual([]);
  });

  it('keys an organization by its registry code, not by its name', () => {
    connector.ingest(tenders, 'prozorro-test');
    const organizations = graph.findByType('Organization');
    expect(organizations.length).toBeGreaterThan(0);
    for (const org of organizations) {
      expect(org.id).toMatch(/^org:edr:\d{8,10}$/);
      expect(String(org.properties.edrpou)).toMatch(/^\d{8,10}$/);
    }
  });

  it('records the award as an edge carrying the amount', () => {
    connector.ingest(tenders, 'prozorro-test');
    const awards = graph.toJSON().edges.filter((e) => e.relation === 'AWARDED_CONTRACT');
    expect(awards.length).toBeGreaterThan(0);
    // `value_concentration` sums `amount` across an entity's edges. An award
    // recorded any other way is invisible to the scoring this feed exists for.
    expect(awards.some((e) => typeof e.properties.amount === 'number')).toBe(true);
    expect(awards.every((e) => typeof e.properties.competitive === 'boolean')).toBe(true);
    expect(awards.every((e) => typeof e.properties.tender_id === 'string')).toBe(true);
  });

  it('does not count a cancelled award as money spent', () => {
    const withCancelled: ProzorroTender[] = [
      {
        tenderID: 'UA-TEST-1',
        title: 'Скасована закупівля',
        procuringEntity: { identifier: { id: '00000001', legalName: 'Покупець' } },
        awards: [
          { status: 'cancelled', value: { amount: 999_999_999, currency: 'UAH' }, suppliers: [{ identifier: { id: '00000002', legalName: 'Продавець' } }] },
        ],
      },
    ];
    const result = connector.ingest(withCancelled, 'prozorro-cancelled');
    expect(result.awardsIngested).toBe(0);
    // Counting failed procedures would inflate every buyer that ever ran one.
    expect(graph.toJSON().edges).toHaveLength(0);
  });

  it('skips a party with no usable registry code, and says which and why', () => {
    const nameOnly: ProzorroTender[] = [
      { tenderID: 'UA-TEST-2', procuringEntity: { name: 'Хтось без коду' } },
      { tenderID: 'UA-TEST-3', procuringEntity: { identifier: { id: 'FR-12345', legalName: 'Foreign SARL' } } },
    ];
    const result = connector.ingest(nameOnly, 'prozorro-nameless');
    expect(result.tendersIngested).toBe(0);
    expect(result.skipped).toHaveLength(2);
    // A name-keyed node would collide with a genuinely different company that
    // shares the name — skipped loudly rather than guessed.
    expect(result.skipped[0].reason).toContain('EDRPOU');
    expect(result.skipped.map((s) => s.tenderID)).toEqual(['UA-TEST-2', 'UA-TEST-3']);
  });

  it('refuses to write a self-loop when buyer and supplier are the same entity', () => {
    const self: ProzorroTender[] = [
      {
        tenderID: 'UA-TEST-4',
        procuringEntity: { identifier: { id: '00000003', legalName: 'Сам собі' } },
        awards: [{ status: 'active', value: { amount: 1000 }, suppliers: [{ identifier: { id: '00000003', legalName: 'Сам собі' } }] }],
      },
    ];
    const result = connector.ingest(self, 'prozorro-self');
    expect(result.awardsIngested).toBe(0);
    expect(result.skipped[0].reason).toContain('same entity');
  });

  it('makes the procurement half of the risk model produce real scores', () => {
    // These signals have existed since the beginning with no source behind
    // them. Half a risk model scoring relations that could not exist is worse
    // than not having it: the bands were computed over nothing.
    connector.ingest(tenders, 'prozorro-test');
    const { nodes, edges } = graph.toJSON();
    const scored = RiskScorer.fromFile(path.join(CONFIG, 'risk_signals.json')).score(nodes, edges);

    const withProcurement = scored.filter((r) => r.signals.some((s) => s.id === 'contract_awarding'));
    expect(withProcurement.length).toBeGreaterThan(0);
    for (const assessment of withProcurement) {
      // Every point still has to be attributable to a named signal.
      expect(assessment.signals.every((s) => s.evidence.length > 0)).toBe(true);
    }
  });

  it('does not hand every entity a structural signal on a sparse graph', () => {
    // Measured on 100 real tenders before the thresholds were guarded: 138 of
    // 164 entities scored above zero and several reached "severe", because
    // every edge of a forest is a bridge and betweenness is normalised against
    // whatever the snapshot's own maximum happens to be.
    connector.ingest(tenders, 'prozorro-test');
    const { nodes, edges } = graph.toJSON();
    const scored = RiskScorer.fromFile(path.join(CONFIG, 'risk_signals.json')).score(nodes, edges);

    const structural = scored.filter((r) => r.signals.some((s) => s.id === 'bridge_endpoint' || s.id === 'high_betweenness'));
    expect(structural.length).toBeLessThan(nodes.length / 2);
    expect(scored.filter((r) => r.band === 'severe')).toHaveLength(0);
  });

  it('indexes the tender for search under the buyer name', () => {
    connector.ingest(tenders, 'prozorro-test');
    const buyer = String(graph.findByType('Organization')[0].properties.legal_name);
    const firstWord = buyer.split(/\s+/).find((w) => w.length > 4)!;
    expect(vectors.search(firstWord, ClearanceLevel.PUBLIC, 5).length).toBeGreaterThan(0);
  });
});
