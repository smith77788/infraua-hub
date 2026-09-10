import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { CaseStore } from '../../core/cases/CaseStore';
import { IngestionService } from '../../core/ingestion/IngestionService';
import { InvestigatorAgent } from '../../agents/analyst/InvestigatorAgent';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';

/**
 * Need-to-know has to hold everywhere a fact can come out, not only on the
 * one method somebody remembered to guard. A compartmented node that stays
 * hidden from `getNode` but surfaces through a two-hop expansion, a search
 * hit, a centrality score or a case listing is not compartmented at all.
 *
 * So this exercises every exit: direct read, traversal, search, investigation
 * and cases - each with a reader who is cleared *above* the marking and read
 * into nothing, which is the case a hierarchical clearance alone gets wrong.
 */
describe('need-to-know across every read path', () => {
  let dir: string;
  let graph: GraphStore;
  let vectors: VectorIndex;
  let audit: AuditLog;
  let cases: CaseStore;
  let investigator: InvestigatorAgent;

  /** Cleared to the top, read into nothing. */
  const outsider = viewer(ClearanceLevel.TOP_SECRET, []);
  /** Cleared no higher than the data, but read in. */
  const insider = viewer(ClearanceLevel.PUBLIC, ['grid']);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compartments-'));
    graph = new GraphStore(path.join(dir, 'graph.json'));
    vectors = new VectorIndex();
    audit = new AuditLog(path.join(dir, 'audit.log'));
    cases = new CaseStore(path.join(dir, 'cases.json'));
    investigator = new InvestigatorAgent(graph, vectors, audit, path.join(dir, 'sandbox'));

    graph.upsertNode({ id: 'open-hub', type: 'Asset', label: 'Відкритий вузол', clearance: ClearanceLevel.PUBLIC });
    graph.upsertNode({
      id: 'closed-hub',
      type: 'Asset',
      label: 'Закритий вузол Дніпро',
      clearance: ClearanceLevel.PUBLIC,
      compartments: ['grid'],
    });
    graph.upsertEdge({
      source: 'open-hub',
      target: 'closed-hub',
      relation: 'SUPPLIES_POWER',
      clearance: ClearanceLevel.PUBLIC,
      compartments: ['grid'],
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('hides a compartmented node from a reader cleared far above it', () => {
    expect(graph.getNode('closed-hub', outsider)).toBeNull();
    expect(graph.getNode('closed-hub', insider)?.label).toContain('Закритий');
  });

  it('keeps it out of type and label searches', () => {
    expect(graph.findByType('Asset', outsider).map((n) => n.id)).toEqual(['open-hub']);
    expect(graph.findByType('Asset', insider).map((n) => n.id)).toContain('closed-hub');
    expect(graph.findByLabelContains('Закритий', outsider)).toHaveLength(0);
  });

  it('does not leak it through traversal from a node the reader can see', () => {
    expect(graph.neighbors('open-hub', outsider)).toHaveLength(0);
    expect(graph.expand('open-hub', 2, outsider).nodes.map((n) => n.id)).toEqual(['open-hub']);
    expect(graph.expand('open-hub', 2, insider).nodes.map((n) => n.id)).toContain('closed-hub');
  });

  it('reports no path to it rather than a shorter one', () => {
    expect(graph.shortestPath('open-hub', 'closed-hub', outsider)).toBeNull();
    expect(graph.shortestPath('open-hub', 'closed-hub', insider)?.nodes).toHaveLength(2);
  });

  it('never returns an edge whose endpoints are invisible', () => {
    const snapshot = graph.toJSON(outsider);
    expect(snapshot.nodes.map((n) => n.id)).toEqual(['open-hub']);
    // An edge with no visible ends still discloses that the ends exist.
    expect(snapshot.edges).toHaveLength(0);
  });

  it('keeps a compartmented document out of search', () => {
    vectors.addDocument({
      id: 'd1',
      text: 'Підстанція Дніпро отримала аварійне живлення',
      source: 'grid-feed',
      sector: 'energy',
      clearance: ClearanceLevel.PUBLIC,
      compartments: ['grid'],
    });
    expect(vectors.search('Дніпро', outsider)).toHaveLength(0);
    expect(vectors.search('Дніпро', insider)).toHaveLength(1);
  });

  it('does not let an investigation anchor on an entity the analyst cannot see', async () => {
    const blind = await investigator.investigate('Закритий вузол Дніпро', outsider);
    // The outsider may still anchor on the open node they share a word with -
    // what must not happen is the compartmented one appearing in the result.
    expect(blind.subgraph.nodes.map((n) => n.id)).not.toContain('closed-hub');
    expect(blind.subgraph.edges).toHaveLength(0);

    const sighted = await investigator.investigate('Закритий вузол Дніпро', insider);
    expect(sighted.subgraph.nodes.map((n) => n.id)).toContain('closed-hub');
  });

  it('records the compartments an investigation ran under, not just the level', async () => {
    await investigator.investigate('Закритий вузол Дніпро', insider);
    const entry = audit.all().find((e) => e.action === 'investigate');
    expect((entry?.details as { compartments: string[] }).compartments).toEqual(['grid']);
  });

  it('will not ingest a compartment away on a later, unmarked assertion', () => {
    const ingestion = new IngestionService(graph, vectors, audit);
    ingestion.ingest('Закритий вузол Дніпро is operational.', 'open.txt', 'energy', ClearanceLevel.PUBLIC);
    // The open re-assertion touches the node; the marking must survive it.
    graph.upsertNode({ id: 'closed-hub', type: 'Asset', label: 'Закритий вузол Дніпро', clearance: ClearanceLevel.PUBLIC });
    expect(graph.getNode('closed-hub', outsider)).toBeNull();
  });

  describe('cases', () => {
    it('raises a case into a circle when compartmented evidence is attached', () => {
      const created = cases.create({ title: 'Знеструмлення', clearance: ClearanceLevel.PUBLIC, createdByKeyId: 'k' });
      expect(cases.get(created.id, outsider)).not.toBeNull();

      const attached = cases.attachFinding(created.id, outsider, {
        auditSeq: 0,
        query: 'q',
        summary: 's',
        narrativeSource: 'deterministic',
        entityIds: ['closed-hub'],
        clearance: ClearanceLevel.PUBLIC,
        compartments: ['grid'],
      });

      expect(attached?.compartmentsAdded).toEqual(['grid']);
      // The attachment narrowed the case - including away from the analyst who
      // made it, which is correct and is why the API reports it.
      expect(cases.get(created.id, outsider)).toBeNull();
      expect(cases.get(created.id, viewer(ClearanceLevel.PUBLIC, ['grid']))).not.toBeNull();
      expect(cases.list(outsider)).toHaveLength(0);
    });

    it('reports nothing added when the evidence is in a circle the case already holds', () => {
      const created = cases.create({
        title: 'Вже закрита справа',
        clearance: ClearanceLevel.PUBLIC,
        compartments: ['grid'],
        createdByKeyId: 'k',
      });
      const attached = cases.attachFinding(created.id, insider, {
        auditSeq: 0,
        query: 'q',
        summary: 's',
        narrativeSource: 'deterministic',
        entityIds: ['closed-hub'],
        clearance: ClearanceLevel.PUBLIC,
        compartments: ['grid'],
      });
      expect(attached?.compartmentsAdded).toEqual([]);
    });
  });
});
