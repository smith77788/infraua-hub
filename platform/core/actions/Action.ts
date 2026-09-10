import { GraphStore } from '../graph/GraphStore';
import { AuditLog } from '../audit/AuditLog';
import { ClearanceLevel } from '../security/Clearance';
import { Viewer } from '../security/Marking';
import { Principal } from '../security/ApiKeyAuth';

/**
 * Typed operations that change the graph.
 *
 * Until now everything that wrote came in through ingestion: the platform
 * could be told things by a feed and could be read by a person, and there was
 * nothing in between. That leaves out the entire category of knowledge that
 * only a person has - an analyst who has stood in front of a substation knows
 * whether the line into it is real, and had no way to say so.
 *
 * An action is that missing half, and it is deliberately not "let the API
 * write to the graph". Every one of them:
 *
 * - **declares what it needs** and refuses malformed input at the boundary,
 *   rather than half-applying and leaving the graph in a state no ingestion
 *   would ever have produced;
 * - **states its preconditions** and explains a refusal in terms of the world
 *   ("that edge is already observed"), not of the code;
 * - **carries its own clearance requirement**, because the right to read a
 *   fact and the right to change it are different rights;
 * - **lands in the audit chain and the revision journal**, so it is
 *   reconstructible and attributable like everything else here.
 *
 * ## The one that needs two people
 *
 * Declassification is the action that can undo every protection in this
 * system, and it is the one an attacker with a single stolen key would reach
 * for first. It therefore does not apply when it is invoked - it is *proposed*,
 * and a different principal has to approve it. That is the only control here
 * that does not fail closed on its own: a single compromised credential cannot
 * exercise it at all.
 */

export type ParameterType = 'string' | 'number' | 'boolean';

export interface ActionParameter {
  name: string;
  type: ParameterType;
  required?: boolean;
  description: string;
}

export interface ActionContext {
  graph: GraphStore;
  audit: AuditLog;
  principal: Principal;
  viewer: Viewer;
  parameters: Record<string, string | number | boolean>;
}

export interface ActionOutcome {
  /** What changed, in the operator's terms — shown back and written to the trail. */
  summary: string;
  /** Entities the action touched, so a case can pin them. */
  affected: string[];
  details?: Record<string, unknown>;
}

export interface ActionDefinition {
  id: string;
  name: string;
  description: string;
  /** Minimum clearance to invoke. Reading a fact and changing it are different rights. */
  requiredClearance: ClearanceLevel;
  /** When true, this is proposed and applies only once a *different* principal approves. */
  requiresSecondPerson?: boolean;
  parameters: ActionParameter[];
  /**
   * Checked before anything is written. Returning a string refuses the action
   * with that reason, phrased for the person who asked, not for the log.
   */
  precondition?(context: ActionContext): string | null;
  apply(context: ActionContext): ActionOutcome;
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

/**
 * Coerces and checks the arguments an action was called with.
 *
 * Strings that look like numbers are converted, because a query string and a
 * form both deliver everything as text and refusing that would make the API
 * usable only from JSON. Everything else is refused rather than guessed: a
 * silently coerced argument is how an action ends up doing something adjacent
 * to what was asked.
 */
export function validateParameters(
  definition: ActionDefinition,
  raw: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const parameters: Record<string, string | number | boolean> = {};

  for (const spec of definition.parameters) {
    const value = raw[spec.name];
    if (value === undefined || value === null || value === '') {
      if (spec.required) throw new ActionError(`"${spec.name}" is required: ${spec.description}`);
      continue;
    }

    if (spec.type === 'string') {
      if (typeof value !== 'string') throw new ActionError(`"${spec.name}" must be a string`);
      parameters[spec.name] = value;
    } else if (spec.type === 'number') {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) throw new ActionError(`"${spec.name}" must be a number`);
      parameters[spec.name] = parsed;
    } else {
      if (typeof value === 'boolean') parameters[spec.name] = value;
      else if (value === 'true') parameters[spec.name] = true;
      else if (value === 'false') parameters[spec.name] = false;
      else throw new ActionError(`"${spec.name}" must be true or false`);
    }
  }

  const declared = new Set(definition.parameters.map((p) => p.name));
  const unknown = Object.keys(raw).filter((key) => !declared.has(key));
  if (unknown.length > 0) {
    // An unrecognised argument is far more often a typo in one that matters
    // than a harmless extra, and silently dropping it applies the action with
    // the caller believing it did something else.
    throw new ActionError(`Unknown parameter(s): ${unknown.join(', ')}. This action takes: ${Array.from(declared).join(', ') || 'none'}.`);
  }

  return parameters;
}
