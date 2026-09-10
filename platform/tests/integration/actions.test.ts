import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { RevisionLog } from '../../core/graph/RevisionLog';
import { AuditLog } from '../../core/audit/AuditLog';
import { ActionRegistry } from '../../core/actions/ActionRegistry';
import { ActionError } from '../../core/actions/Action';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';
import { Principal } from '../../core/security/ApiKeyAuth';

const CONFIG = path.join(__dirname, '..', '..', 'config');

const principal = (id: string, clearance: ClearanceLevel): Principal => ({
  id,
  clearance,
  compartments: [],
  purposes: [],
});

describe('ontology actions', () => {
  let dir: string;
  let graph: GraphStore;
  let audit: AuditLog;
  let registry: ActionRegistry;

  const olena = principal('olena', ClearanceLevel.SECRET);
  const petro = principal('petro', ClearanceLevel.SECRET);
  const junior = principal('junior', ClearanceLevel.PUBLIC);
  const view = (p: Principal) => viewer(p.clearance, p.compartments);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-'));
    graph = new GraphStore(
      path.join(dir, 'graph.json'),
      OntologyManifest.fromFile(path.join(CONFIG, 'ontology.json')),
      new RevisionLog(path.join(dir, 'revisions.log')),
    );
    audit = new AuditLog(path.join(dir, 'audit.log'));
    registry = new ActionRegistry(graph, audit, path.join(dir, 'pending.json'));

    graph.upsertNode({ id: 'plant', type: 'Asset', label: 'Електростанція', properties: { lat: 49, lon: 35 } });
    graph.upsertNode({ id: 'sub', type: 'Asset', label: 'Підстанція', properties: { lat: 49.2, lon: 35.1 } });
    graph.upsertEdge({
      source: 'plant',
      target: 'sub',
      relation: 'SUPPLIES_POWER',
      properties: { provenance_kind: 'inferred', method: 'найближча електростанція', confidence: 0.35 },
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('confirming an inferred dependency', () => {
    it('is the only way a person can put what they know into the graph', () => {
      // The console builds this edge by nearest neighbour at confidence 0.35,
      // and every outage conclusion rests on it. Someone who has seen the line
      // had no way to say so until this existed.
      const result = registry.invoke(
        'confirm_dependency',
        { from: 'plant', to: 'sub', note: 'звірено з диспетчером' },
        olena,
        view(olena),
      );
      expect(result.status).toBe('applied');

      const edge = graph.toJSON().edges[0];
      expect(edge.properties.provenance_kind).toBe('observed');
      expect(edge.properties.observed_by).toBe('olena');
      // The method it used to rest on is kept, not overwritten: a reader can
      // still see how the edge came to be proposed.
      expect(edge.properties.inferred_method).toBe('найближча електростанція');
      expect(edge.properties.confirmation_note).toBe('звірено з диспетчером');
    });

    it('refuses a second confirmation in the operator\'s words, not the code\'s', () => {
      registry.invoke('confirm_dependency', { from: 'plant', to: 'sub' }, olena, view(olena));
      expect(() => registry.invoke('confirm_dependency', { from: 'plant', to: 'sub' }, petro, view(petro))).toThrow(
        /уже підтверджено/,
      );
    });

    it('answers "not there" the same way for missing and for invisible', () => {
      expect(() => registry.invoke('confirm_dependency', { from: 'plant', to: 'nowhere' }, olena, view(olena))).toThrow(
        /No SUPPLIES_POWER relation/,
      );
    });
  });

  describe('damage and repair', () => {
    it('records the moment as valid time, so the grid can be reconstructed', () => {
      registry.invoke('mark_damaged', { entityId: 'sub', since: '2026-09-03T04:00:00.000Z', cause: 'удар' }, olena, view(olena));

      const node = graph.getNode('sub')!;
      expect(node.properties.status).toBe('damaged');
      expect(node.valid_from).toBe('2026-09-03T04:00:00.000Z');
      // Before the strike the substation was not yet in this state.
      expect(graph.asOf({ validAt: '2026-09-02T00:00:00.000Z' }).nodes.map((n) => n.id)).not.toContain('sub');
      expect(graph.asOf({ validAt: '2026-09-04T00:00:00.000Z' }).nodes.map((n) => n.id)).toContain('sub');
    });

    it('clears the damage interval on repair instead of leaving it open', () => {
      registry.invoke('mark_damaged', { entityId: 'sub', since: '2026-09-03T04:00:00.000Z' }, olena, view(olena));
      registry.invoke('mark_restored', { entityId: 'sub', since: '2026-09-08T10:00:00.000Z' }, olena, view(olena));

      const node = graph.getNode('sub')!;
      expect(node.properties.status).toBe('operational');
      // An open-ended interval left behind would hide the node from every
      // validAt query after the repair.
      expect(node.valid_to).toBeUndefined();
      expect(graph.asOf({ validAt: '2026-09-09T00:00:00.000Z' }).nodes.map((n) => n.id)).toContain('sub');
    });

    it('will not repair something that was never marked broken', () => {
      expect(() => registry.invoke('mark_restored', { entityId: 'plant' }, olena, view(olena))).toThrow(/не позначено/);
    });

    it('rejects a timestamp that is not one', () => {
      expect(() => registry.invoke('mark_damaged', { entityId: 'sub', since: 'вчора' }, olena, view(olena))).toThrow(
        /ISO 8601/,
      );
    });
  });

  describe('identity', () => {
    it('records sameness as a relation rather than eating both records', () => {
      graph.upsertNode({ id: 'org-a', type: 'Organization', label: 'Дніпро Енерго ТОВ' });
      graph.upsertNode({ id: 'org-b', type: 'Organization', label: 'Дніпро Енерго LLC' });

      registry.invoke('link_same_as', { a: 'org-a', b: 'org-b', basis: 'той самий ЄДРПОУ у реєстрі' }, olena, view(olena));

      const edge = graph.toJSON().edges.find((e) => e.relation === 'SAME_AS')!;
      expect(edge.properties.decided_by).toBe('olena');
      expect(edge.properties.basis).toContain('ЄДРПОУ');
      // A merge destroys the evidence for itself, and identity decisions are
      // sometimes wrong. Both originals are still here.
      expect(graph.getNode('org-a')).not.toBeNull();
      expect(graph.getNode('org-b')).not.toBeNull();
    });

    it('refuses the commonest false identity of all', () => {
      graph.upsertNode({ id: 'p', type: 'Person', label: 'Southern Cross' });
      graph.upsertNode({ id: 'o', type: 'Organization', label: 'Southern Cross' });
      expect(() => registry.invoke('link_same_as', { a: 'p', b: 'o', basis: 'однакова назва' }, olena, view(olena))).toThrow(
        /Різні типи/,
      );
    });
  });

  describe('declassification needs two people', () => {
    beforeEach(() => {
      graph.upsertNode({ id: 'secret-node', type: 'Asset', label: 'Закритий вузол', clearance: ClearanceLevel.SECRET });
    });

    const proposal = { entityId: 'secret-node', toClearance: 'INTERNAL', reason: 'дані оприлюднено оператором' };

    it('does not apply when it is invoked', () => {
      const result = registry.invoke('declassify', proposal, olena, view(olena));
      expect(result.status).toBe('pending');
      // A single stolen key cannot exercise this at all — the only control
      // here that does more than fail closed.
      expect(graph.getNode('secret-node')!.clearance).toBe(ClearanceLevel.SECRET);
      expect(registry.listPending()).toHaveLength(1);
    });

    it('cannot be approved by the person who proposed it', () => {
      const pending = registry.invoke('declassify', proposal, olena, view(olena)).pending!;
      expect(() => registry.approve(pending.id, olena, view(olena))).toThrow(/other than the person/);
    });

    it('applies once a different principal approves, and names both', () => {
      const pending = registry.invoke('declassify', proposal, olena, view(olena)).pending!;
      const applied = registry.approve(pending.id, petro, view(petro));

      expect(applied.status).toBe('applied');
      expect(graph.getNode('secret-node')!.clearance).toBe(ClearanceLevel.INTERNAL);
      expect(registry.listPending()).toHaveLength(0);

      const entry = audit.all().find((e) => e.action === 'action_applied')!;
      const details = entry.details as { proposedBy: string; approvedBy: string };
      // "Who did this" has two answers, and a trail that gives one is wrong.
      expect(details.proposedBy).toBe('olena');
      expect(details.approvedBy).toBe('petro');
    });

    it('expires rather than waiting forever to be approved by accident', () => {
      const shortLived = new ActionRegistry(graph, audit, path.join(dir, 'p2.json'), undefined, 0);
      const pending = shortLived.invoke('declassify', proposal, olena, view(olena)).pending!;
      expect(() => shortLived.approve(pending.id, petro, view(petro))).toThrow(/expired/);
    });

    it('re-checks the precondition at approval, because the world moves', () => {
      const pending = registry.invoke('declassify', proposal, olena, view(olena)).pending!;
      // Someone declassifies it by another route in the meantime.
      graph.upsertNode({ id: 'secret-node', type: 'Asset', label: 'Закритий вузол', clearance: ClearanceLevel.PUBLIC });
      expect(() => registry.approve(pending.id, petro, view(petro))).toThrow(/No longer applicable/);
    });

    it('lets only the proposer withdraw', () => {
      const pending = registry.invoke('declassify', proposal, olena, view(olena)).pending!;
      expect(() => registry.withdraw(pending.id, petro)).toThrow(/Only the proposer/);
      expect(registry.withdraw(pending.id, olena).id).toBe(pending.id);
    });

    it('refuses a raise dressed up as a lowering', () => {
      expect(() =>
        registry.invoke('declassify', { ...proposal, toClearance: 'TOP_SECRET' }, olena, view(olena)),
      ).toThrow(/не зниження/);
    });
  });

  describe('the boundary', () => {
    it('refuses an action above the caller clearance', () => {
      expect(() => registry.invoke('link_same_as', { a: 'plant', b: 'sub', basis: 'x' }, junior, view(junior))).toThrow(
        /CONFIDENTIAL/,
      );
    });

    it('refuses an unknown parameter rather than silently dropping it', () => {
      // Far more often a typo in one that matters than a harmless extra, and
      // dropping it applies the action with the caller believing otherwise.
      expect(() =>
        registry.invoke('mark_damaged', { entityId: 'sub', sinse: '2026-09-03T04:00:00.000Z' }, olena, view(olena)),
      ).toThrow(/Unknown parameter/);
    });

    it('refuses a missing required parameter, naming what it is for', () => {
      try {
        registry.invoke('mark_damaged', {}, olena, view(olena));
        throw new Error('should have refused');
      } catch (err) {
        expect((err as ActionError).message).toContain('ідентифікатор обʼєкта');
      }
    });

    it('lists an action the caller cannot run, saying what it needs', () => {
      const entry = registry.catalogue(ClearanceLevel.PUBLIC).find((a) => a.id === 'declassify')!;
      // Hiding it entirely just produces a support question.
      expect(entry.permitted).toBe(false);
      expect(entry.requiredClearance).toBe(ClearanceLevel.SECRET);
    });

    it('puts every applied action in the audit chain', () => {
      registry.invoke('mark_damaged', { entityId: 'sub' }, olena, view(olena));
      const entry = audit.all().find((e) => e.action === 'action_applied')!;
      expect(entry.actor).toBe('olena');
      expect((entry.details as { actionId: string }).actionId).toBe('mark_damaged');
      expect(audit.verify().valid).toBe(true);
    });
  });
});
