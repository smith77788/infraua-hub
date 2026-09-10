import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { RevisionLog } from '../../core/graph/RevisionLog';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { RiskScorer } from '../../core/analytics/RiskScorer';
import { ToolRegistry } from '../../agents/analyst/tools/ToolRegistry';
import { builtInTools } from '../../agents/analyst/tools/tools';
import { ToolError } from '../../agents/analyst/tools/Tool';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';
import { Principal } from '../../core/security/ApiKeyAuth';

const CONFIG = path.join(__dirname, '..', '..', 'config');

const principal = (
  id: string,
  clearance: ClearanceLevel,
  compartments: string[] = [],
): Principal => ({ id, clearance, compartments, purposes: [] });

const view = (p: Principal) => viewer(p.clearance, p.compartments);

describe('the analyst tool registry', () => {
  let dir: string;
  let graph: GraphStore;
  let vectors: VectorIndex;
  let audit: AuditLog;
  let registry: ToolRegistry;

  const junior = principal('junior', ClearanceLevel.PUBLIC);
  const analyst = principal('olena', ClearanceLevel.INTERNAL);
  const officer = principal('officer', ClearanceLevel.CONFIDENTIAL, ['personal-data']);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
    graph = new GraphStore(
      path.join(dir, 'graph.json'),
      OntologyManifest.fromFile(path.join(CONFIG, 'ontology.json')),
      new RevisionLog(path.join(dir, 'revisions.log')),
    );
    vectors = new VectorIndex();
    audit = new AuditLog(path.join(dir, 'audit.log'));
    registry = new ToolRegistry(
      graph,
      vectors,
      audit,
      path.join(dir, 'sandbox'),
      builtInTools(RiskScorer.fromFile(path.join(CONFIG, 'risk_signals.json'))),
    );

    graph.upsertNode({ id: 'plant', type: 'Asset', label: 'Станція Південна', properties: { lat: 48, lon: 35 } });
    graph.upsertNode({ id: 'sub', type: 'Asset', label: 'Підстанція Гайова', properties: { lat: 48.5, lon: 35.2 } });
    graph.upsertNode({
      id: 'secret-sub',
      type: 'Asset',
      label: 'Підстанція Закрита',
      compartments: ['grid'],
    });
    graph.upsertEdge({ source: 'plant', target: 'sub', relation: 'SUPPLIES_POWER' });
    vectors.addDocument({
      id: 'd1',
      text: 'Підстанція Гайова перейшла на резервне живлення',
      source: 'feed',
      sector: 'energy',
      clearance: ClearanceLevel.PUBLIC,
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('the catalogue', () => {
    it('says what a caller may not use, and what it would take', () => {
      // Hiding it would leave a planner unable to say "this needs a clearance
      // you do not have", which is a usable answer.
      const forJunior = registry.catalogue(junior);
      const conflicts = forJunior.find((t) => t.name === 'conflicts_of_interest')!;
      expect(conflicts.permitted).toBe(false);
      expect(conflicts.reason).toContain('CONFIDENTIAL');

      const forOfficer = registry.catalogue(officer);
      expect(forOfficer.find((t) => t.name === 'conflicts_of_interest')!.permitted).toBe(true);
    });

    it('describes each tool in the words a planner needs to choose it', () => {
      for (const tool of registry.catalogue(analyst)) {
        expect(tool.description.length).toBeGreaterThan(20);
        for (const parameter of tool.parameters) expect(parameter.description).toBeTruthy();
      }
    });
  });

  describe('rights are checked on every call', () => {
    it('refuses a tool above the caller level, naming what it needs', async () => {
      await expect(registry.call('conflicts_of_interest', {}, junior, view(junior))).rejects.toThrow(
        /CONFIDENTIAL/,
      );
    });

    it('does not let one permitted call open the door for the rest', async () => {
      // A session-level check would have; this is the difference.
      const first = await registry.call('find_entities', { text: 'Підстанція' }, junior, view(junior));
      expect(first.result.shape.entities).toBeGreaterThan(0);
      await expect(registry.call('risk_assessment', {}, junior, view(junior))).rejects.toThrow(/INTERNAL/);
    });

    it('records a refusal, not only a success', async () => {
      // A trail holding only the successful calls cannot show a plan reaching
      // for something it was not entitled to.
      await registry.call('risk_assessment', {}, junior, view(junior)).catch(() => undefined);
      const entry = audit.all().find((e) => e.action === 'tool_refused');
      expect(entry).toBeDefined();
      expect((entry!.details as { tool: string }).tool).toBe('risk_assessment');
    });
  });

  describe('results are the caller view, never more', () => {
    it('does not return an entity outside the caller compartments', async () => {
      const outside = await registry.call('find_entities', { text: 'Підстанція' }, analyst, view(analyst));
      expect(JSON.stringify(outside.result.data)).not.toContain('Закрита');

      const insider = principal('insider', ClearanceLevel.INTERNAL, ['grid']);
      const inside = await registry.call('find_entities', { text: 'Підстанція' }, insider, view(insider));
      expect(JSON.stringify(inside.result.data)).toContain('Закрита');
    });

    it('answers "not there" the same way for missing and for invisible', async () => {
      await expect(registry.call('expand_entity', { id: 'secret-sub' }, analyst, view(analyst))).rejects.toThrow(
        /немає у вашому погляді/,
      );
      await expect(registry.call('expand_entity', { id: 'no-such-node' }, analyst, view(analyst))).rejects.toThrow(
        /немає у вашому погляді/,
      );
    });
  });

  describe('arguments', () => {
    it('refuses an unknown argument rather than dropping it', async () => {
      // When the planner is a model this is the difference between a mistake
      // that surfaces and a plan that quietly did something else while
      // describing what it meant to do.
      await expect(
        registry.call('find_entities', { text: 'Підстанція', tpye: 'Asset' }, analyst, view(analyst)),
      ).rejects.toThrow(/Unknown argument/);
    });

    it('names what a missing required argument is for', async () => {
      try {
        await registry.call('search_documents', {}, analyst, view(analyst));
        throw new Error('should have refused');
      } catch (err) {
        expect((err as ToolError).message).toContain('текст запиту');
      }
    });

    it('refuses an entity type that is not one', async () => {
      await expect(
        registry.call('find_entities', { text: 'x', type: 'Alien' }, analyst, view(analyst)),
      ).rejects.toThrow(/not an entity type/);
    });
  });

  describe('the tools themselves', () => {
    it('searches the corpus this reader has', async () => {
      const { result } = await registry.call('search_documents', { query: 'резервне живлення' }, analyst, view(analyst));
      expect(result.shape.documents).toBeGreaterThan(0);
    });

    it('walks the graph from an entity', async () => {
      const { result } = await registry.call('expand_entity', { id: 'plant', depth: 2 }, analyst, view(analyst));
      expect(result.shape.nodes).toBe(2);
      expect(result.shape.edges).toBe(1);
    });

    it('reports no path rather than inventing one', async () => {
      const { result } = await registry.call(
        'connections_between',
        { from: 'plant', to: 'secret-sub' },
        analyst,
        view(analyst),
      );
      expect((result.data as { connected: boolean }).connected).toBe(false);
    });

    it('reaches a past revision', async () => {
      const before = graph.history()!.head();
      graph.upsertNode({ id: 'later', type: 'Asset', label: 'Пізніший вузол' });
      const { result } = await registry.call('graph_as_of', { asOfSeq: before }, analyst, view(analyst));
      expect(JSON.stringify(result.data)).not.toContain('Пізніший');
    });

    it('insists on a cursor rather than guessing which past is meant', async () => {
      await expect(registry.call('graph_as_of', {}, analyst, view(analyst))).rejects.toThrow(/курсор/);
    });

    it('computes with executed code, not with a model', async () => {
      // The rule the whole investigator rests on: a language model is never
      // the thing that produces a number, it is shown one.
      const { result } = await registry.call(
        'compute_total',
        { values: '1000, 2500, 500', operation: 'sum' },
        analyst,
        view(analyst),
      );
      expect((result.data as { result: number }).result).toBe(4000);
      expect((result.data as { count: number }).count).toBe(3);
    });

    it('refuses an operation it does not have', async () => {
      await expect(
        registry.call('compute_total', { values: '1,2', operation: 'median' }, analyst, view(analyst)),
      ).rejects.toThrow(/Невідома операція/);
    });
  });

  describe('the trail', () => {
    it('records the call in counts, never in content', async () => {
      await registry.call('search_documents', { query: 'резервне живлення' }, analyst, view(analyst));
      const entry = audit.all().find((e) => e.action === 'tool_call')!;
      expect(entry.actor).toBe('olena');
      const details = entry.details as { tool: string; returned: Record<string, number> };
      expect(details.tool).toBe('search_documents');
      expect(details.returned.documents).toBeGreaterThan(0);
      // The trail says how much came back, never what.
      expect(JSON.stringify(entry)).not.toContain('резервне живлення відновлено');
      expect(audit.verify().valid).toBe(true);
    });

    it('leaves a record per step, so a plan can be replayed', async () => {
      await registry.call('find_entities', { text: 'Підстанція' }, analyst, view(analyst));
      await registry.call('expand_entity', { id: 'plant' }, analyst, view(analyst));
      const calls = audit.all().filter((e) => e.action === 'tool_call');
      expect(calls.map((e) => (e.details as { tool: string }).tool)).toEqual([
        'find_entities',
        'expand_entity',
      ]);
    });
  });

  it('offers no way to write', () => {
    // Structural, not a policy: changing the graph goes through
    // core/actions/, so a planner has no path to a write at all.
    const names = registry.names();
    expect(names).not.toContain('upsert_node');
    for (const name of names) {
      expect(name).not.toMatch(/create|update|delete|write|set_|mark_|declassify/);
    }
  });
});
