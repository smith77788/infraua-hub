import { GraphStore } from '../../../core/graph/GraphStore';
import { VectorIndex } from '../../../core/vector/VectorIndex';
import { AuditLog } from '../../../core/audit/AuditLog';
import { ClearanceLevel } from '../../../core/security/Clearance';
import { Viewer } from '../../../core/security/Marking';
import { Principal } from '../../../core/security/ApiKeyAuth';

/**
 * The tools an analyst agent may use, as data rather than as a code path.
 *
 * `InvestigatorAgent` runs one fixed procedure: search, resolve anchors,
 * expand two hops, maybe compute, narrate. That procedure is reliable and its
 * ceiling is low - it answers the questions it was written for and no others,
 * and every new question means new code in the middle of the agent.
 *
 * A registry inverts that. Each capability declares what it does, what
 * arguments it takes and what it requires of the caller; a planner - a person,
 * the deterministic flow, or a model - picks a sequence. What makes this safe
 * rather than merely flexible is where the permission check sits:
 *
 * ## Rights are checked per call, not per session
 *
 * A caller does not get "access to the platform" and then roam. Every single
 * tool call re-checks the caller's clearance against that tool's own
 * requirement, and every tool reads through the caller's viewer, so results
 * are filtered by the same rule as everywhere else. A plan that reaches a tool
 * the caller may not use fails at that step with the reason, having already
 * done the steps it was entitled to.
 *
 * That matters most when the planner is a model: a model that can be talked
 * into calling a tool still cannot be talked into having the clearance for it,
 * because the check does not consult the plan, only the principal.
 *
 * ## Every tool here is read-only, and that is structural
 *
 * Nothing in this registry writes. Changing the graph goes through
 * `core/actions/`, which has preconditions, a two-person rule where it
 * matters, and its own audit action. Keeping the two apart means a planner -
 * again, possibly a model - has no path to a write at all: not a policy it
 * could be argued out of, but a capability it was never given.
 */

export type ToolParameterType = 'string' | 'number' | 'boolean';

export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  required?: boolean;
  /** Read by whoever - or whatever - is choosing the arguments. */
  description: string;
}

export interface ToolContext {
  graph: GraphStore;
  vectors: VectorIndex;
  audit: AuditLog;
  principal: Principal;
  viewer: Viewer;
  /** Directory for sandboxed computation, when a tool needs one. */
  sandboxDir: string;
}

export interface ToolResult {
  /** One line saying what happened, for the plan trace and the audit entry. */
  summary: string;
  data: unknown;
  /** Counts only - what the audit trail records instead of the content. */
  shape: Record<string, number>;
}

export interface ToolDefinition {
  name: string;
  /** What this is for, in the words a planner needs to choose it. */
  description: string;
  parameters: ToolParameter[];
  requiredClearance: ClearanceLevel;
  /**
   * Compartments the caller must hold on top of the level. Empty for tools
   * whose results are already filtered to the caller's own view - which is
   * most of them; this is for tools whose *existence* is the disclosure.
   */
  requiredCompartments?: string[];
  run(args: Record<string, string | number | boolean>, context: ToolContext): Promise<ToolResult>;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Checks and coerces a call's arguments.
 *
 * Unknown arguments are refused rather than dropped. When a planner is a
 * model this is the difference between a mistake that surfaces and a plan that
 * quietly did something other than what it described - and the model's own
 * account of what it did would be the wrong one.
 */
export function validateToolArgs(
  tool: ToolDefinition,
  raw: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const args: Record<string, string | number | boolean> = {};

  for (const spec of tool.parameters) {
    const value = raw[spec.name];
    if (value === undefined || value === null || value === '') {
      if (spec.required) throw new ToolError(`"${spec.name}" is required: ${spec.description}`);
      continue;
    }
    if (spec.type === 'string') {
      if (typeof value !== 'string') throw new ToolError(`"${spec.name}" must be a string`);
      args[spec.name] = value;
    } else if (spec.type === 'number') {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) throw new ToolError(`"${spec.name}" must be a number`);
      args[spec.name] = parsed;
    } else {
      if (typeof value === 'boolean') args[spec.name] = value;
      else if (value === 'true') args[spec.name] = true;
      else if (value === 'false') args[spec.name] = false;
      else throw new ToolError(`"${spec.name}" must be true or false`);
    }
  }

  const declared = new Set(tool.parameters.map((p) => p.name));
  const unknown = Object.keys(raw).filter((key) => !declared.has(key));
  if (unknown.length > 0) {
    throw new ToolError(
      `Unknown argument(s): ${unknown.join(', ')}. "${tool.name}" takes: ${Array.from(declared).join(', ') || 'none'}.`,
    );
  }

  return args;
}

/** The catalogue entry a planner sees. Never includes the implementation. */
export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: ToolParameter[];
  requiredClearance: ClearanceLevel;
  requiredCompartments: string[];
  /** Whether this caller may actually use it, and why not when they may not. */
  permitted: boolean;
  reason?: string;
}
