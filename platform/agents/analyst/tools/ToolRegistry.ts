import { GraphStore } from '../../../core/graph/GraphStore';
import { VectorIndex } from '../../../core/vector/VectorIndex';
import { AuditLog } from '../../../core/audit/AuditLog';
import { ClearanceLevel, clearanceAtLeast } from '../../../core/security/Clearance';
import { Viewer } from '../../../core/security/Marking';
import { Principal } from '../../../core/security/ApiKeyAuth';
import { ToolDefinition, ToolDescriptor, ToolError, ToolResult, validateToolArgs } from './Tool';

/**
 * Dispatches tool calls, checking the caller's rights on every one.
 *
 * The check is deliberately not "does this session have access" but "may this
 * principal use this tool, right now". Those look the same until a plan runs
 * several steps: with a session-level check, the first permitted call opens
 * the door for the rest; with a per-call check, a plan does exactly the steps
 * its caller is entitled to and stops at the one it is not, having done the
 * others.
 *
 * That distinction is the whole safety story when the planner is a model. A
 * model can be persuaded to *attempt* anything; it cannot be persuaded into
 * holding a clearance, because the check reads the principal and never the
 * plan.
 */

export interface ToolCallRecord {
  tool: string;
  args: Record<string, string | number | boolean>;
  summary: string;
  shape: Record<string, number>;
  durationMs: number;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorIndex,
    private readonly audit: AuditLog,
    private readonly sandboxDir: string,
    definitions: ToolDefinition[] = [],
  ) {
    for (const tool of definitions) this.tools.set(tool.name, tool);
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * What this caller may choose from.
   *
   * Tools they cannot use are listed too, with the level named. Hiding them
   * would leave a planner unable to say "this needs a clearance you do not
   * have", which is a usable answer, and would leave a person filing a support
   * question instead.
   */
  catalogue(principal: Principal): ToolDescriptor[] {
    return Array.from(this.tools.values())
      .map((tool) => {
        const required = tool.requiredCompartments ?? [];
        const held = new Set(principal.compartments);
        const missing = required.filter((c) => !held.has(c));
        const levelOk = clearanceAtLeast(principal.clearance, tool.requiredClearance);
        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          requiredClearance: tool.requiredClearance,
          requiredCompartments: required,
          permitted: levelOk && missing.length === 0,
          ...(levelOk && missing.length === 0
            ? {}
            : {
                reason: !levelOk
                  ? `Потрібен рівень ${ClearanceLevel[tool.requiredClearance]}.`
                  : `Потрібен допуск до кола: ${missing.join(', ')}.`,
              }),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return Array.from(this.tools.keys()).sort();
  }

  async call(
    name: string,
    rawArgs: Record<string, unknown>,
    principal: Principal,
    viewer: Viewer,
  ): Promise<{ result: ToolResult; record: ToolCallRecord }> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`Інструмента "${name}" не існує.`, 404);

    if (!clearanceAtLeast(principal.clearance, tool.requiredClearance)) {
      // Refusals are recorded. A trail holding only the successful calls
      // cannot show a plan reaching for something it was not entitled to,
      // which is the pattern worth seeing when a model wrote the plan.
      this.audit.append(principal.id, 'tool_refused', {
        tool: name,
        reason: 'clearance',
        required: tool.requiredClearance,
        held: principal.clearance,
      });
      throw new ToolError(`"${name}" потребує рівня ${ClearanceLevel[tool.requiredClearance]}.`, 403);
    }

    const missing = (tool.requiredCompartments ?? []).filter((c) => !principal.compartments.includes(c));
    if (missing.length > 0) {
      this.audit.append(principal.id, 'tool_refused', { tool: name, reason: 'compartment', missing });
      throw new ToolError(`"${name}" потребує допуску до кола: ${missing.join(', ')}.`, 403);
    }

    const args = validateToolArgs(tool, rawArgs);
    const started = Date.now();
    const result = await tool.run(args, {
      graph: this.graph,
      vectors: this.vectors,
      audit: this.audit,
      principal,
      viewer,
      sandboxDir: this.sandboxDir,
    });
    const durationMs = Date.now() - started;

    this.audit.append(principal.id, 'tool_call', {
      tool: name,
      args,
      summary: result.summary,
      // Counts, never content: the trail says how much came back and of what,
      // for the same reason the read audit does.
      returned: result.shape,
      durationMs,
    });

    return { result, record: { tool: name, args, summary: result.summary, shape: result.shape, durationMs } };
  }
}
