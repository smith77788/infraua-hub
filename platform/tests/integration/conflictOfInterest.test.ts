import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { ProzorroConnector } from '../../core/ingestion/ProzorroConnector';
import { EdrConnector } from '../../core/ingestion/EdrConnector';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { AuditLog } from '../../core/audit/AuditLog';
import { ActionRegistry } from '../../core/actions/ActionRegistry';
import {
  findCommonOwnership,
  findConflictsOfInterest,
} from '../../core/analytics/ConflictOfInterest';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';
import { Principal } from '../../core/security/ApiKeyAuth';

const CONFIG = path.join(__dirname, '..', '..', 'config');

/**
 * The pattern this looks for is a path, and the pattern the risk config used
 * to look for was a single node's own edges. That difference is the whole
 * reason `self_dealing_pattern` had never fired on real data: a person does
 * not award contracts, an organisation does.
 */
describe('conflicts of interest', () => {
  let dir: string;
  let graph: GraphStore;
  let audit: AuditLog;

  const all = viewer(ClearanceLevel.TOP_SECRET, ['personal-data']);
  const analyst: Principal = {
    id: 'olena',
    clearance: ClearanceLevel.SECRET,
    compartments: ['personal-data'],
    purposes: [],
  };

  const snapshot = () => graph.toJSON(all);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-'));
    graph = new GraphStore(
      path.join(dir, 'graph.json'),
      OntologyManifest.fromFile(path.join(CONFIG, 'ontology.json')),
    );
    audit = new AuditLog(path.join(dir, 'audit.log'));

    graph.upsertNode({ id: 'org:edr:11111111', type: 'Organization', label: 'Замовник Міськрада' });
    graph.upsertNode({ id: 'org:edr:22222222', type: 'Organization', label: 'ТОВ Постачальник' });
    // The register keys a person to the company that named them, so the same
    // human appears twice under two ids.
    graph.upsertNode({
      id: 'person:edr:11111111:коваленко_іван_петрович',
      type: 'Person',
      label: 'Коваленко Іван Петрович',
      compartments: ['personal-data'],
    });
    graph.upsertNode({
      id: 'person:edr:22222222:коваленко_іван_петрович',
      type: 'Person',
      label: 'КОВАЛЕНКО ІВАН ПЕТРОВИЧ',
      compartments: ['personal-data'],
    });
    graph.upsertEdge({
      source: 'person:edr:11111111:коваленко_іван_петрович',
      target: 'org:edr:11111111',
      relation: 'AFFILIATED_WITH',
      properties: { role: 'керівник' },
      compartments: ['personal-data'],
    });
    graph.upsertEdge({
      source: 'person:edr:22222222:коваленко_іван_петрович',
      target: 'org:edr:22222222',
      relation: 'BENEFICIARY_OF',
      properties: { role: 'beneficiary', share_percent: 100 },
      compartments: ['personal-data'],
    });
    graph.upsertEdge({
      source: 'org:edr:11111111',
      target: 'org:edr:22222222',
      relation: 'AWARDED_CONTRACT',
      properties: { tender_id: 'UA-2026-1', amount: 4_000_000, currency: 'UAH', competitive: false },
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('sees the three-hop path a single-node rule cannot', () => {
    const { confirmed, unconfirmed } = findConflictsOfInterest(snapshot().nodes, snapshot().edges);
    expect(confirmed).toHaveLength(0);
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0].buyer.label).toContain('Міськрада');
    expect(unconfirmed[0].supplier.label).toContain('Постачальник');
    expect(unconfirmed[0].totalAmount).toBe(4_000_000);
  });

  it('calls it a question about identity, not a conclusion about a person', () => {
    // Treating equal names as the same person would manufacture an accusation
    // against real people out of a coincidence of spelling.
    const { unconfirmed } = findConflictsOfInterest(snapshot().nodes, snapshot().edges);
    expect(unconfirmed[0].status).toBe('unconfirmed');
    expect(unconfirmed[0].openQuestion).toContain('link_same_as');
    expect(unconfirmed[0].personIds).toHaveLength(2);
  });

  it('becomes a finding once a human settles the identity', () => {
    const registry = new ActionRegistry(graph, audit, path.join(dir, 'pending.json'));
    registry.invoke(
      'link_same_as',
      {
        a: 'person:edr:11111111:коваленко_іван_петрович',
        b: 'person:edr:22222222:коваленко_іван_петрович',
        basis: 'той самий РНОКПП у декларації',
      },
      analyst,
      viewer(analyst.clearance, analyst.compartments),
    );

    const { confirmed, unconfirmed } = findConflictsOfInterest(snapshot().nodes, snapshot().edges);
    expect(unconfirmed).toHaveLength(0);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].evidence.join(' ')).toContain('підтверджена рішенням аналітика');
  });

  it('reads without the graph next to it', () => {
    const { unconfirmed } = findConflictsOfInterest(snapshot().nodes, snapshot().edges);
    const text = unconfirmed[0].evidence.join(' | ');
    expect(text).toContain('керівник у замовника');
    expect(text).toContain('beneficiary у постачальника');
    expect(text).toContain('присудив');
  });

  it('says nothing when nobody is on both ends', () => {
    graph.upsertNode({ id: 'org:edr:33333333', type: 'Organization', label: 'Інший постачальник' });
    graph.upsertEdge({
      source: 'org:edr:11111111',
      target: 'org:edr:33333333',
      relation: 'AWARDED_CONTRACT',
      properties: { tender_id: 'UA-2026-2', amount: 9_000_000 },
    });
    const findings = findConflictsOfInterest(snapshot().nodes, snapshot().edges);
    expect(findings.confirmed).toHaveLength(0);
    expect(findings.unconfirmed).toHaveLength(1);
    expect(findings.unconfirmed[0].supplier.id).toBe('org:edr:22222222');
  });

  it('respects the threshold rather than reporting every small purchase', () => {
    const findings = findConflictsOfInterest(snapshot().nodes, snapshot().edges, {
      minAmount: 10_000_000,
    });
    expect(findings.confirmed).toHaveLength(0);
    expect(findings.unconfirmed).toHaveLength(0);
  });

  it('cannot see a conflict through people the reader is not cleared for', () => {
    // The path runs through personal data. A reader outside that circle sees
    // the contract and neither end of the person, so there is nothing to find
    // - and nothing is hinted at either.
    const outside = graph.toJSON(viewer(ClearanceLevel.TOP_SECRET, []));
    const findings = findConflictsOfInterest(outside.nodes, outside.edges);
    expect(findings.confirmed).toHaveLength(0);
    expect(findings.unconfirmed).toHaveLength(0);
  });

  describe('common ownership behind several suppliers', () => {
    beforeEach(() => {
      graph.upsertNode({ id: 'org:edr:44444444', type: 'Organization', label: 'ТОВ Другий постачальник' });
      graph.upsertNode({
        id: 'person:edr:44444444:коваленко_іван_петрович',
        type: 'Person',
        label: 'Коваленко Іван Петрович',
        compartments: ['personal-data'],
      });
      graph.upsertEdge({
        source: 'person:edr:44444444:коваленко_іван_петрович',
        target: 'org:edr:44444444',
        relation: 'BENEFICIARY_OF',
        properties: { role: 'beneficiary' },
        compartments: ['personal-data'],
      });
      graph.upsertEdge({
        source: 'org:edr:11111111',
        target: 'org:edr:44444444',
        relation: 'AWARDED_CONTRACT',
        properties: { tender_id: 'UA-2026-3', amount: 1_500_000, competitive: true },
      });
    });

    it('asks whether there was a choice at all', () => {
      // A competitive procedure between companies that share an owner is the
      // classic way a competition is staged, and no measure of a single
      // contract can see it.
      const findings = findCommonOwnership(snapshot().nodes, snapshot().edges);
      expect(findings).toHaveLength(1);
      expect(findings[0].suppliers).toHaveLength(2);
      expect(findings[0].evidence[0]).toContain('2 постачальникам');
    });

    it('holds the same identity discipline as the path finder', () => {
      const findings = findCommonOwnership(snapshot().nodes, snapshot().edges);
      expect(findings[0].status).toBe('unconfirmed');
      expect(findings[0].openQuestion).toContain('link_same_as');
    });

    it('says nothing about a buyer with one supplier', () => {
      graph.upsertNode({ id: 'org:edr:55555555', type: 'Organization', label: 'Самотній замовник' });
      graph.upsertEdge({
        source: 'org:edr:55555555',
        target: 'org:edr:22222222',
        relation: 'AWARDED_CONTRACT',
        properties: { tender_id: 'UA-2026-4', amount: 100 },
      });
      const findings = findCommonOwnership(snapshot().nodes, snapshot().edges);
      expect(findings.map((f) => f.buyer.id)).not.toContain('org:edr:55555555');
    });
  });

  describe('the two registers join on one key', () => {
    it('writes one node for a company both connectors saw', () => {
      // Prozorro keys a party by its EDRPOU, and so does the register. That is
      // the whole reason the procurement side and the ownership side end up in
      // one graph rather than two disconnected halves - and it is worth
      // pinning, because a key scheme that drifts fails silently: both halves
      // keep working, and nothing ever joins.
      const vectors = new VectorIndex();
      new ProzorroConnector(graph, vectors, audit).ingest(
        [
          {
            tenderID: 'UA-JOIN-1',
            title: 'Спільна закупівля',
            procuringEntity: { identifier: { id: '77777777', legalName: 'Замовник спільний' } },
            awards: [
              {
                status: 'active',
                value: { amount: 1000, currency: 'UAH' },
                suppliers: [{ identifier: { id: '88888888', legalName: 'ТОВ Спільне' } }],
              },
            ],
          },
        ],
        'prozorro-join',
      );

      new EdrConnector(graph, vectors, audit).ingest(
        [
          {
            edrpou: '88888888',
            name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "СПІЛЬНЕ"',
            founders: [],
            beneficiaries: ['Петренко Петро Петрович; громадянство: Україна; відсоток частки - 100'],
            signers: [],
          },
        ],
        'edr-join',
      );

      const supplier = graph.getNode('org:edr:88888888', all)!;
      expect(supplier).not.toBeNull();
      // One node, both provenances: the contract and the ownership hang off
      // the same company.
      expect(supplier.source_doc_ids.some((d) => d.startsWith('prozorro-join'))).toBe(true);
      expect(supplier.source_doc_ids.some((d) => d.startsWith('edr-join'))).toBe(true);

      const relations = graph
        .neighbors('org:edr:88888888', all)
        .map((n) => n.edge.relation)
        .sort();
      expect(relations).toEqual(['AWARDED_CONTRACT', 'BENEFICIARY_OF']);
    });
  });
});
