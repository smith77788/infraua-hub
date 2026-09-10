import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ClearanceLevel } from '../security/Clearance';
import { asViewer, canRead, unionCompartments, ViewerInput } from '../security/Marking';
import { AlertSeverity, SEVERITY_ORDER } from './AlertRule';

/**
 * The triage queue: alerts that fired, what happened to them, and who decided.
 *
 * An alerting system without state is a notification system, and notifications
 * do not survive contact with a shift change. The state machine is the point -
 * `new` means nobody has looked, `acknowledged` means somebody owns it,
 * `resolved` means it was dealt with and by whom. Those three answers are what
 * turn a stream of events into work that can be handed over.
 *
 * ## Deduplication is the difference between a queue and a flood
 *
 * A standing query re-evaluates continuously and most conditions keep holding:
 * a substation inside a geofence is still inside it a minute later. Emitting a
 * fresh alert each time buries the one thing that changed under a thousand
 * things that did not. So a firing that matches an already-open alert on the
 * same (rule, entity) updates it - occurrence count and last-seen - instead of
 * creating another.
 */

export type AlertState = 'new' | 'acknowledged' | 'resolved';

export interface AlertTransition {
  from: AlertState;
  to: AlertState;
  at: string;
  /** Principal id, so a handover can say who took it. */
  actor: string;
  note?: string;
}

export interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  /** The rule's own description, carried so the queue explains itself. */
  ruleDescription: string;
  entityId: string;
  entityLabel: string;
  severity: AlertSeverity;
  state: AlertState;
  /** Why this entity matched — the lines the evaluator produced. */
  evidence: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** How many evaluations have seen this same condition still holding. */
  occurrences: number;
  clearance: ClearanceLevel;
  compartments?: string[];
  transitions: AlertTransition[];
}

export interface RaiseInput {
  ruleId: string;
  ruleName: string;
  ruleDescription: string;
  entityId: string;
  entityLabel: string;
  severity: AlertSeverity;
  evidence: string[];
  clearance: ClearanceLevel;
  compartments: string[];
  /** How long a resolved alert stays closed before this condition may reopen it. */
  reopenAfterMinutes: number;
}

export interface RaiseOutcome {
  alert: Alert;
  /** 'raised' for a new alert, 'reopened' after the quiet period, 'repeated' otherwise. */
  outcome: 'raised' | 'reopened' | 'repeated';
}

export class AlertStore {
  private alerts = new Map<string, Alert>();

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Alert[];
      for (const alert of raw) this.alerts.set(alert.id, alert);
    }
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(Array.from(this.alerts.values()), null, 2), 'utf-8');
  }

  private openFor(ruleId: string, entityId: string): Alert | undefined {
    for (const alert of this.alerts.values()) {
      if (alert.ruleId === ruleId && alert.entityId === entityId && alert.state !== 'resolved') return alert;
    }
    return undefined;
  }

  private lastResolvedFor(ruleId: string, entityId: string): Alert | undefined {
    let latest: Alert | undefined;
    for (const alert of this.alerts.values()) {
      if (alert.ruleId !== ruleId || alert.entityId !== entityId || alert.state !== 'resolved') continue;
      if (!latest || alert.lastSeenAt > latest.lastSeenAt) latest = alert;
    }
    return latest;
  }

  /**
   * Records one firing.
   *
   * Marking is the rule's floor raised to cover the entity that matched. An
   * alert about a compartmented asset that carried only the rule's own marking
   * would be a leak with a siren attached: the label, the coordinates in the
   * evidence and the fact that it matched at all are exactly the disclosure the
   * compartment exists to prevent.
   */
  raise(input: RaiseInput, now = new Date()): RaiseOutcome {
    const timestamp = now.toISOString();
    const clearance = Math.max(input.clearance, ClearanceLevel.PUBLIC) as ClearanceLevel;
    const compartments = unionCompartments([input.compartments]);

    const open = this.openFor(input.ruleId, input.entityId);
    if (open) {
      open.occurrences += 1;
      open.lastSeenAt = timestamp;
      open.evidence = input.evidence;
      open.severity = input.severity;
      // Marking can only ever rise: a later firing that saw less than an
      // earlier one must not declassify what is already recorded.
      open.clearance = Math.max(open.clearance, clearance) as ClearanceLevel;
      const merged = unionCompartments([open.compartments, compartments]);
      if (merged.length) open.compartments = merged;
      this.persist();
      return { alert: open, outcome: 'repeated' };
    }

    const resolved = this.lastResolvedFor(input.ruleId, input.entityId);
    if (resolved) {
      const quietUntil = new Date(new Date(resolved.lastSeenAt).getTime() + input.reopenAfterMinutes * 60_000);
      if (now < quietUntil) {
        // Inside the quiet period: somebody decided this was handled, and a
        // condition that has not changed is not new information.
        resolved.occurrences += 1;
        this.persist();
        return { alert: resolved, outcome: 'repeated' };
      }
    }

    const alert: Alert = {
      id: `alert-${crypto.randomUUID()}`,
      ruleId: input.ruleId,
      ruleName: input.ruleName,
      ruleDescription: input.ruleDescription,
      entityId: input.entityId,
      entityLabel: input.entityLabel,
      severity: input.severity,
      state: 'new',
      evidence: input.evidence,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      occurrences: 1,
      clearance,
      ...(compartments.length ? { compartments } : {}),
      transitions: [],
    };
    this.alerts.set(alert.id, alert);
    this.persist();
    return { alert, outcome: resolved ? 'reopened' : 'raised' };
  }

  list(
    who: ViewerInput,
    filter: { state?: AlertState; ruleId?: string; minSeverity?: AlertSeverity } = {},
  ): Alert[] {
    const v = asViewer(who);
    const floor = filter.minSeverity ? SEVERITY_ORDER[filter.minSeverity] : -1;
    return Array.from(this.alerts.values())
      .filter((a) => canRead(v, a))
      .filter((a) => (filter.state ? a.state === filter.state : true))
      .filter((a) => (filter.ruleId ? a.ruleId === filter.ruleId : true))
      .filter((a) => SEVERITY_ORDER[a.severity] >= floor)
      .sort(
        (a, b) =>
          SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
  }

  /** Null both when it does not exist and when it is outside the caller's view. */
  get(id: string, who: ViewerInput): Alert | null {
    const found = this.alerts.get(id);
    if (!found || !canRead(who, found)) return null;
    return found;
  }

  /**
   * Moves an alert through the queue.
   *
   * Refuses a transition that is not a move (`new` -> `new`) and refuses to
   * reopen a resolved alert by hand: reopening happens when the **condition**
   * fires again, which is a fact about the world, not a click. Letting a person
   * flip it back would put the queue and the data out of step with each other.
   */
  transition(
    id: string,
    who: ViewerInput,
    to: AlertState,
    actor: string,
    note?: string,
  ): { alert: Alert } | { error: string } | null {
    const alert = this.get(id, who);
    if (!alert) return null;
    if (alert.state === to) return { error: `Alert is already ${to}.` };
    if (alert.state === 'resolved') {
      return { error: 'A resolved alert reopens when its condition fires again, not by hand.' };
    }
    if (to === 'new') return { error: 'An alert cannot be moved back to new.' };

    alert.transitions.push({ from: alert.state, to, at: new Date().toISOString(), actor, ...(note ? { note } : {}) });
    alert.state = to;
    this.persist();
    return { alert };
  }

  /** Queue shape at a glance, for the console banner and the bot. */
  summary(who: ViewerInput): { total: number; byState: Record<AlertState, number>; bySeverity: Record<AlertSeverity, number> } {
    const visible = this.list(who);
    const byState: Record<AlertState, number> = { new: 0, acknowledged: 0, resolved: 0 };
    const bySeverity: Record<AlertSeverity, number> = { info: 0, elevated: 0, high: 0, critical: 0 };
    for (const alert of visible) {
      byState[alert.state] += 1;
      bySeverity[alert.severity] += 1;
    }
    return { total: visible.length, byState, bySeverity };
  }

  size(): number {
    return this.alerts.size;
  }
}
