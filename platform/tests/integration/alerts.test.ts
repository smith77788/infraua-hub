import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { AuditLog } from '../../core/audit/AuditLog';
import { RiskScorer } from '../../core/analytics/RiskScorer';
import { AlertStore } from '../../core/alerts/AlertStore';
import { AlertEngine } from '../../core/alerts/AlertEngine';
import { parseRule } from '../../core/alerts/AlertRule';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';

/**
 * The behaviour that separates a standing query from a view: it keeps state
 * between evaluations. Everything worth testing here is about that state -
 * whether a condition that keeps holding floods the queue, whether a resolved
 * alert comes back, and whether an alert about a compartmented asset is itself
 * compartmented.
 */
describe('standing queries', () => {
  let dir: string;
  let graph: GraphStore;
  let audit: AuditLog;
  let store: AlertStore;
  let engine: AlertEngine;

  const analyst = viewer(ClearanceLevel.SECRET, []);
  const scorer = new RiskScorer([]);

  const proximityRule = parseRule({
    id: 'event-near-asset',
    name: 'Подія поруч з обʼєктом',
    description: 'Подія ближче ніж за 15 км від обʼєкта.',
    severity: 'high',
    reopenAfterMinutes: 60,
    condition: {
      kind: 'all',
      of: [
        { kind: 'entity', nodeType: 'Asset' },
        { kind: 'proximity', nearType: 'Event', radiusKm: 15 },
      ],
    },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
    graph = new GraphStore(path.join(dir, 'graph.json'));
    audit = new AuditLog(path.join(dir, 'audit.log'));
    store = new AlertStore(path.join(dir, 'alerts.json'));
    engine = new AlertEngine(graph, store, scorer, audit, [proximityRule]);

    graph.upsertNode({
      id: 'sub-1',
      type: 'Asset',
      label: 'Підстанція Південна',
      properties: { lat: 48.5, lon: 35.0, voltage: 330000 },
      clearance: ClearanceLevel.PUBLIC,
    });
    graph.upsertNode({
      id: 'far-sub',
      type: 'Asset',
      label: 'Підстанція Далека',
      properties: { lat: 51.5, lon: 24.0 },
      clearance: ClearanceLevel.PUBLIC,
    });
    graph.upsertNode({
      id: 'fire-1',
      type: 'Event',
      label: 'Пожежа',
      properties: { lat: 48.52, lon: 35.03 },
      clearance: ClearanceLevel.PUBLIC,
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('fires on the entity in range and not on the one out of range', () => {
    const outcome = engine.evaluate('tester', analyst);
    expect(outcome.raised).toBe(1);
    expect(outcome.visible[0].entityId).toBe('sub-1');
    expect(store.list(analyst).map((a) => a.entityId)).toEqual(['sub-1']);
  });

  it('explains itself, so the queue does not have to be taken on faith', () => {
    engine.evaluate('tester', analyst);
    const [alert] = store.list(analyst);
    expect(alert.evidence.join(' ')).toContain('is a Asset');
    expect(alert.evidence.join(' ')).toContain('Пожежа');
    // The operator reads the rule's own words next to the firing.
    expect(alert.ruleDescription).toContain('15 км');
  });

  it('counts a condition that keeps holding instead of filing it again', () => {
    engine.evaluate('tester', analyst);
    const second = engine.evaluate('tester', analyst);
    expect(second.raised).toBe(0);
    expect(second.repeated).toBe(1);

    const [alert] = store.list(analyst);
    expect(alert.occurrences).toBe(2);
    expect(store.list(analyst)).toHaveLength(1);
  });

  it('keeps a resolved alert closed through its quiet period', () => {
    engine.evaluate('tester', analyst);
    const [alert] = store.list(analyst);
    store.transition(alert.id, analyst, 'resolved', 'olena', 'перевірено на місці');

    const soon = engine.evaluate('tester', analyst, new Date(Date.now() + 5 * 60_000));
    expect(soon.raised).toBe(0);
    expect(store.list(analyst, { state: 'new' })).toHaveLength(0);
  });

  it('reopens once the quiet period has passed, because a recurrence is news', () => {
    engine.evaluate('tester', analyst);
    const [alert] = store.list(analyst);
    store.transition(alert.id, analyst, 'resolved', 'olena');

    const later = engine.evaluate('tester', analyst, new Date(Date.now() + 61 * 60_000));
    expect(later.reopened).toBe(1);
    expect(store.list(analyst, { state: 'new' })).toHaveLength(1);
  });

  describe('need-to-know', () => {
    /** A rule sees a circle only by being marked into it. */
    const gridRule = parseRule({ ...proximityRule, id: 'event-near-asset-grid', compartments: ['grid'] });
    const insider = viewer(ClearanceLevel.PUBLIC, ['grid']);

    const addCompartmentedAsset = () =>
      graph.upsertNode({
        id: 'sub-secret',
        type: 'Asset',
        label: 'Закрита підстанція',
        properties: { lat: 48.51, lon: 35.01 },
        clearance: ClearanceLevel.PUBLIC,
        compartments: ['grid'],
      });

    it('does not watch a circle no rule is marked into', () => {
      // Watching is a form of access. A rule authored from outside a circle
      // must not be able to probe it, so compartmented data stays unmonitored
      // until someone inside writes a rule for it.
      addCompartmentedAsset();
      const outcome = engine.evaluate('tester', analyst);
      expect(outcome.raised).toBe(1);
      expect(outcome.hidden).toBe(0);
    });

    it('marks an alert to cover the entity that produced it', () => {
      addCompartmentedAsset();
      engine.upsertRule(gridRule);

      const outcome = engine.evaluate('tester', analyst);
      // The sweep saw it because the rule is in the circle; the analyst who
      // triggered the sweep is not, so nothing that rule produced comes back
      // to them - two firings, one of them about an entity they *can* read,
      // because what a compartmented rule matched is itself in that circle.
      expect(outcome.hidden).toBe(2);
      expect(outcome.visible.map((a) => a.entityId)).not.toContain('sub-secret');

      expect(store.list(insider).map((a) => a.entityId)).toContain('sub-secret');
      expect(JSON.stringify(store.list(analyst))).not.toContain('Закрита підстанція');
    });

    it('keeps the rule itself out of a list the reader is not in', () => {
      // A rule's name and condition say what is watched and where - the same
      // disclosure as the data it watches.
      engine.upsertRule(gridRule);
      expect(engine.listRules(analyst).map((r) => r.id)).not.toContain('event-near-asset-grid');
      expect(engine.listRules(insider).map((r) => r.id)).toContain('event-near-asset-grid');
    });

    it('records the whole sweep in the trail, including what the caller could not see', () => {
      addCompartmentedAsset();
      engine.upsertRule(gridRule);
      engine.evaluate('tester', analyst);

      const entry = audit.all().find((e) => e.action === 'alerts_evaluated')!;
      const details = entry.details as { raised: number; withheldFromCaller: number };
      // Three firings: the open rule on the open asset, and the grid rule on
      // both. Two are withheld — including the grid rule's firing on the *open*
      // asset, because what a compartmented rule matched is itself in that
      // circle even when the entity is not.
      expect(details.raised).toBe(3);
      expect(details.withheldFromCaller).toBe(2);
    });
  });

  describe('triage', () => {
    it('records who took an alert and who closed it', () => {
      engine.evaluate('tester', analyst);
      const [alert] = store.list(analyst);

      store.transition(alert.id, analyst, 'acknowledged', 'olena');
      const result = store.transition(alert.id, analyst, 'resolved', 'petro', 'хибне спрацювання');
      expect(result && 'alert' in result).toBe(true);

      const [after] = store.list(analyst);
      expect(after.state).toBe('resolved');
      expect(after.transitions.map((t) => t.actor)).toEqual(['olena', 'petro']);
      expect(after.transitions[1].note).toBe('хибне спрацювання');
    });

    it('will not let a person reopen by hand what only the data can reopen', () => {
      engine.evaluate('tester', analyst);
      const [alert] = store.list(analyst);
      store.transition(alert.id, analyst, 'resolved', 'olena');

      const result = store.transition(alert.id, analyst, 'acknowledged', 'olena');
      expect(result).toEqual({ error: 'A resolved alert reopens when its condition fires again, not by hand.' });
    });

    it('hides an alert outside the caller view rather than refusing it differently', () => {
      graph.upsertNode({
        id: 'sub-secret',
        type: 'Asset',
        label: 'Закрита підстанція',
        properties: { lat: 48.51, lon: 35.01 },
        clearance: ClearanceLevel.PUBLIC,
        compartments: ['grid'],
      });
      engine.upsertRule(parseRule({ ...proximityRule, id: 'grid-watch', compartments: ['grid'] }));
      engine.evaluate('tester', analyst);
      const insider = viewer(ClearanceLevel.PUBLIC, ['grid']);
      const hidden = store.list(insider).find((a) => a.entityId === 'sub-secret')!;

      // Same answer as "no such alert": a distinct one would confirm it exists.
      expect(store.get(hidden.id, analyst)).toBeNull();
      expect(store.transition(hidden.id, analyst, 'acknowledged', 'x')).toBeNull();
    });
  });

  describe('rules', () => {
    it('replaces a rule by id rather than running both versions', () => {
      // A noisy rule that was edited and re-submitted must stop being noisy.
      engine.upsertRule(parseRule({ ...proximityRule, description: 'Оновлений опис', enabled: false }));
      expect(engine.listRules()).toHaveLength(1);
      expect(engine.evaluate('tester', analyst).evaluatedRules).toBe(0);
    });

    it('loads the shipped rule set without throwing', () => {
      const rules = AlertEngine.rulesFromFile(path.join(__dirname, '..', '..', 'config', 'alert_rules.json'));
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.description.length > 0)).toBe(true);
    });
  });
});
