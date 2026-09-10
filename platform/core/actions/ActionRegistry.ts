import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GraphStore } from '../graph/GraphStore';
import { AuditLog } from '../audit/AuditLog';
import { ClearanceLevel, clearanceAtLeast } from '../security/Clearance';
import { Viewer } from '../security/Marking';
import { Principal } from '../security/ApiKeyAuth';
import { ActionContext, ActionDefinition, ActionError, ActionOutcome, validateParameters } from './Action';
import { BUILT_IN_ACTIONS } from './actions';

/**
 * Dispatches actions, and holds the ones that need a second person.
 *
 * ## Why a proposal expires
 *
 * A pending declassification is a standing offer to weaken the system, and an
 * offer nobody remembers making is the easiest thing in the world to approve
 * by accident three weeks later. So proposals have a lifetime, after which
 * they are refused rather than quietly applied.
 *
 * ## Why the approver's own view is checked again
 *
 * The approval is a second *decision*, not a rubber stamp on the first, so
 * the action is validated and applied under the approver's view. If they
 * cannot see the entity, they cannot approve a change to it - otherwise the
 * two-person rule degrades into "one person who understands it, plus one who
 * clicks".
 */

export interface PendingAction {
  id: string;
  actionId: string;
  parameters: Record<string, string | number | boolean>;
  proposedBy: string;
  proposedAt: string;
  expiresAt: string;
  reason: string;
}

export interface ExecutionResult {
  status: 'applied' | 'pending';
  action: string;
  outcome?: ActionOutcome;
  pending?: PendingAction;
}

const DEFAULT_PROPOSAL_TTL_MINUTES = 60 * 24;

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition>();
  private pending = new Map<string, PendingAction>();

  constructor(
    private readonly graph: GraphStore,
    private readonly audit: AuditLog,
    private readonly pendingPath?: string,
    definitions: ActionDefinition[] = BUILT_IN_ACTIONS,
    private readonly proposalTtlMinutes: number = DEFAULT_PROPOSAL_TTL_MINUTES,
  ) {
    for (const definition of definitions) this.actions.set(definition.id, definition);
    if (pendingPath) {
      fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
      if (fs.existsSync(pendingPath)) {
        for (const entry of JSON.parse(fs.readFileSync(pendingPath, 'utf-8')) as PendingAction[]) {
          this.pending.set(entry.id, entry);
        }
      }
    }
  }

  private persist(): void {
    if (!this.pendingPath) return;
    fs.writeFileSync(this.pendingPath, JSON.stringify(Array.from(this.pending.values()), null, 2), 'utf-8');
  }

  /** Actions this principal is cleared to invoke, with their parameters. */
  catalogue(clearance: ClearanceLevel): (Omit<ActionDefinition, 'apply' | 'precondition'> & { permitted: boolean })[] {
    return Array.from(this.actions.values()).map(({ apply, precondition, ...rest }) => ({
      ...rest,
      // Listed even when not permitted, with the level named: "you need
      // SECRET for this" is a usable answer, and hiding the action entirely
      // just produces a support question.
      permitted: clearanceAtLeast(clearance, rest.requiredClearance),
    }));
  }

  listPending(now = new Date()): PendingAction[] {
    return Array.from(this.pending.values())
      .filter((entry) => entry.expiresAt > now.toISOString())
      .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
  }

  invoke(
    actionId: string,
    rawParameters: Record<string, unknown>,
    principal: Principal,
    viewer: Viewer,
    now = new Date(),
  ): ExecutionResult {
    const definition = this.actions.get(actionId);
    if (!definition) throw new ActionError(`No action "${actionId}".`, 404);
    if (!clearanceAtLeast(principal.clearance, definition.requiredClearance)) {
      throw new ActionError(
        `"${definition.id}" requires ${ClearanceLevel[definition.requiredClearance]} clearance.`,
        403,
      );
    }

    const parameters = validateParameters(definition, rawParameters);
    const context: ActionContext = { graph: this.graph, audit: this.audit, principal, viewer, parameters };

    // Preconditions run before a proposal is filed as well as before a direct
    // apply, so a two-person action that could never succeed is refused at the
    // moment it is proposed rather than at the moment somebody approves it.
    const refusal = definition.precondition?.(context);
    if (refusal) throw new ActionError(refusal, 409);

    if (definition.requiresSecondPerson) {
      const entry: PendingAction = {
        id: `pending-${crypto.randomUUID()}`,
        actionId: definition.id,
        parameters,
        proposedBy: principal.id,
        proposedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.proposalTtlMinutes * 60_000).toISOString(),
        reason: String(parameters.reason ?? ''),
      };
      this.pending.set(entry.id, entry);
      this.persist();
      this.audit.append(principal.id, 'action_proposed', {
        actionId: definition.id,
        pendingId: entry.id,
        parameters,
        expiresAt: entry.expiresAt,
      });
      return { status: 'pending', action: definition.id, pending: entry };
    }

    return { status: 'applied', action: definition.id, outcome: this.applyNow(definition, context) };
  }

  /**
   * Approves a pending action, under the approver's own view.
   *
   * Three refusals, each of which is the rule rather than a check:
   * the approver may not be the proposer; the proposal may not have expired;
   * and the action must still pass its precondition, because the world may
   * have moved between the proposal and the approval.
   */
  approve(pendingId: string, principal: Principal, viewer: Viewer, now = new Date()): ExecutionResult {
    const entry = this.pending.get(pendingId);
    if (!entry) throw new ActionError('No such pending action.', 404);
    if (entry.expiresAt <= now.toISOString()) {
      this.pending.delete(pendingId);
      this.persist();
      throw new ActionError('That proposal has expired. Propose it again if it is still wanted.', 409);
    }
    if (entry.proposedBy === principal.id) {
      throw new ActionError('A proposal must be approved by someone other than the person who made it.', 403);
    }

    const definition = this.actions.get(entry.actionId);
    if (!definition) throw new ActionError(`Action "${entry.actionId}" no longer exists.`, 409);
    if (!clearanceAtLeast(principal.clearance, definition.requiredClearance)) {
      throw new ActionError(`Approving "${definition.id}" requires ${ClearanceLevel[definition.requiredClearance]} clearance.`, 403);
    }

    const context: ActionContext = {
      graph: this.graph,
      audit: this.audit,
      principal,
      viewer,
      parameters: entry.parameters,
    };
    const refusal = definition.precondition?.(context);
    if (refusal) throw new ActionError(`No longer applicable: ${refusal}`, 409);

    const outcome = this.applyNow(definition, context, { approvedFrom: entry });
    this.pending.delete(pendingId);
    this.persist();
    return { status: 'applied', action: definition.id, outcome };
  }

  /** Withdraws a proposal. Only its author, and it is recorded. */
  withdraw(pendingId: string, principal: Principal): PendingAction {
    const entry = this.pending.get(pendingId);
    if (!entry) throw new ActionError('No such pending action.', 404);
    if (entry.proposedBy !== principal.id) throw new ActionError('Only the proposer can withdraw a proposal.', 403);
    this.pending.delete(pendingId);
    this.persist();
    this.audit.append(principal.id, 'action_withdrawn', { pendingId, actionId: entry.actionId });
    return entry;
  }

  private applyNow(
    definition: ActionDefinition,
    context: ActionContext,
    extra: { approvedFrom?: PendingAction } = {},
  ): ActionOutcome {
    const outcome = definition.apply(context);
    this.audit.append(context.principal.id, 'action_applied', {
      actionId: definition.id,
      parameters: context.parameters,
      summary: outcome.summary,
      affected: outcome.affected,
      details: outcome.details ?? null,
      // Both names on the record for a two-person action, because "who did
      // this" has two answers and a trail that gives one of them is wrong.
      proposedBy: extra.approvedFrom?.proposedBy ?? null,
      approvedBy: extra.approvedFrom ? context.principal.id : null,
    });
    return outcome;
  }
}
