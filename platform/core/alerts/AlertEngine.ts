import * as fs from 'fs';
import { GraphStore } from '../graph/GraphStore';
import { AuditLog } from '../audit/AuditLog';
import { RiskScorer } from '../analytics/RiskScorer';
import { ClearanceLevel } from '../security/Clearance';
import { asViewer, canRead, unionCompartments, ViewerInput } from '../security/Marking';
import { AlertRule, parseRule } from './AlertRule';
import { matchNodes } from './ConditionEvaluator';
import { Alert, AlertStore } from './AlertStore';

/**
 * Runs every enabled standing query over the graph and files what it finds.
 *
 * ## Which view rules are evaluated in
 *
 * A sweep runs in the **rules' own view**, never the caller's: top clearance,
 * and exactly the compartments the enabled rules themselves name. Two things
 * follow, and both are deliberate.
 *
 * A rule evaluated at the triggering analyst's level would go blind precisely
 * when a fact becomes classified, and the alert nobody happens to be cleared
 * for is the one most worth raising. So the caller's clearance does not enter
 * into it at all.
 *
 * But watching is a form of access, so a rule sees a compartment only by being
 * marked into it - which its author can only do if they are read into it
 * themselves. Compartmented data is therefore unmonitored until somebody
 * inside that circle writes a rule for it. That is the fail-closed direction
 * and it is the honest one: the alternative lets a rule authored from outside
 * probe a circle it has no relationship with.
 *
 * Containment is on the output as well: each alert is marked to cover the
 * entity that produced it, so a sweep can file alerts the person who started
 * it cannot read. The response says how many, and nothing else about them.
 * That count is a deliberate, narrow channel - "something is happening you are
 * not cleared for" is operationally worth more than the inference it costs.
 */

export interface EvaluationOutcome {
  evaluatedRules: number;
  matches: number;
  raised: number;
  reopened: number;
  repeated: number;
  /** Alerts from this sweep the triggering caller may read. */
  visible: Alert[];
  /** How many it may not — a count only, deliberately. */
  hidden: number;
}

export class AlertEngine {
  constructor(
    private readonly graph: GraphStore,
    private readonly store: AlertStore,
    private readonly riskScorer: RiskScorer,
    private readonly audit: AuditLog,
    private rules: AlertRule[] = [],
  ) {}

  static rulesFromFile(filePath: string): AlertRule[] {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { rules?: unknown[] };
    if (!Array.isArray(parsed.rules)) throw new Error(`${filePath}: expected a "rules" array`);
    return parsed.rules.map(parseRule);
  }

  /**
   * Rules the caller may see.
   *
   * A rule is not neutral metadata: its name, description and condition say
   * what is being watched and where, which is the same disclosure as the data
   * it watches. So the list is filtered by the reader's own view, exactly like
   * the graph. Called with no argument it returns everything, for internal
   * callers that already hold the sweep view.
   */
  listRules(who?: ViewerInput): AlertRule[] {
    if (who === undefined) return [...this.rules];
    const v = asViewer(who);
    return this.rules.filter((r) => canRead(v, { clearance: r.clearance, compartments: r.compartments }));
  }

  /**
   * Adds or replaces a rule at runtime.
   *
   * Replacing by id rather than appending: a rule edited and re-submitted must
   * not leave its previous version firing alongside the new one, which is how
   * a "fixed" noisy rule keeps making noise.
   */
  upsertRule(rule: AlertRule): void {
    const index = this.rules.findIndex((r) => r.id === rule.id);
    if (index >= 0) this.rules[index] = rule;
    else this.rules.push(rule);
  }

  removeRule(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    return this.rules.length < before;
  }

  /**
   * @param triggeredBy principal id, for the audit entry
   * @param reportTo the view used to decide which of the resulting alerts come
   *        back in the response — never which ones are evaluated
   */
  evaluate(triggeredBy: string, reportTo: ViewerInput, now = new Date()): EvaluationOutcome {
    const active = this.rules.filter((r) => r.enabled);

    const outcome: EvaluationOutcome = {
      evaluatedRules: active.length,
      matches: 0,
      raised: 0,
      reopened: 0,
      repeated: 0,
      visible: [],
      hidden: 0,
    };

    const reader = asViewer(reportTo);

    // One snapshot per distinct compartment set, not one shared snapshot for
    // the whole sweep. A single snapshot taken at the union of every rule's
    // compartments would let a rule marked into nothing match a node it has no
    // relationship with, purely because some *other* rule named that circle -
    // which is the containment this layer claims, quietly not holding.
    //
    // Risk is scored per snapshot for the same reason it is everywhere else:
    // centrality computed over nodes outside the view leaks their existence
    // through the scores of the ones inside it.
    for (const [, group] of this.groupByView(active)) {
      const view = {
        clearance: ClearanceLevel.TOP_SECRET,
        compartments: new Set(group[0].compartments),
      };
      const { nodes, edges } = this.graph.toJSON(view);
      const risk = new Map(this.riskScorer.score(nodes, edges).map((r) => [r.id, r]));

      for (const rule of group) {
        const matches = matchNodes(rule.condition, { nodes, edges, risk });
        outcome.matches += matches.length;

        for (const match of matches) {
          const result = this.store.raise(
            {
              ruleId: rule.id,
              ruleName: rule.name,
              ruleDescription: rule.description,
              entityId: match.node.id,
              entityLabel: match.node.label,
              severity: rule.severity,
              evidence: match.evidence,
              // The rule's floor raised to the entity's own marking.
              clearance: Math.max(rule.clearance, match.node.clearance) as ClearanceLevel,
              compartments: unionCompartments([rule.compartments, match.node.compartments]),
              reopenAfterMinutes: rule.reopenAfterMinutes,
            },
            now,
          );

          if (result.outcome === 'raised') outcome.raised += 1;
          else if (result.outcome === 'reopened') outcome.reopened += 1;
          else outcome.repeated += 1;

          if (result.outcome !== 'repeated') {
            if (this.store.get(result.alert.id, reader)) outcome.visible.push(result.alert);
            else outcome.hidden += 1;
          }
        }
      }
    }

    this.audit.append(triggeredBy, 'alerts_evaluated', {
      evaluatedRules: outcome.evaluatedRules,
      matches: outcome.matches,
      raised: outcome.raised,
      reopened: outcome.reopened,
      repeated: outcome.repeated,
      // Recorded whole, so the trail shows a sweep produced alerts even when
      // the person who ran it could not be shown them.
      withheldFromCaller: outcome.hidden,
    });

    return outcome;
  }

  /** Rules sharing a compartment set share a snapshot; nothing else does. */
  private groupByView(rules: AlertRule[]): Map<string, AlertRule[]> {
    const groups = new Map<string, AlertRule[]>();
    for (const rule of rules) {
      const key = unionCompartments([rule.compartments]).join('|');
      const group = groups.get(key) ?? [];
      group.push(rule);
      groups.set(key, group);
    }
    return groups;
  }
}
