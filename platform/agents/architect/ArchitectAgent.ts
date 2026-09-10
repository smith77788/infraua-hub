import { Agent, AgentExecutionContext, AgentExecutionResult } from '../../core/agents/Agent';
import { createMessage } from '../../core/agents/AgentMessage';
import { Memory } from '../../core/memory/Memory';

export interface PlanContent {
  summary: string;
  acceptance_criteria: string[];
  subtasks: string[];
}

/**
 * Understands the task and produces a technical plan + acceptance
 * criteria. Deliberately does not touch production code - its output
 * is handed to the coder as an implementation_request.
 *
 * This is a mock/deterministic implementation for the MVP core. A real
 * adapter (e.g. calling Claude) can replace the body of `plan()` without
 * changing the Agent interface or the orchestrator.
 */
export class ArchitectAgent implements Agent {
  readonly id = 'architect-1';
  readonly name = 'Claude (Architect)';
  readonly role = 'architect' as const;
  readonly capabilities = ['decomposition', 'acceptance_criteria', 'technical_planning'];

  constructor(private readonly memory: Memory) {}

  async execute(context: AgentExecutionContext): Promise<AgentExecutionResult<PlanContent>> {
    const { task } = context;
    const plan = this.plan(task.title, task.description);

    this.memory.write(
      'architecture',
      task.id,
      `# Plan for ${task.id}: ${task.title}\n\n${plan.summary}\n\n## Acceptance criteria\n${plan.acceptance_criteria
        .map((c) => `- ${c}`)
        .join('\n')}\n`
    );
    this.memory.write(
      'decisions',
      `${task.id}-plan`,
      `Architect decided to implement "${task.title}" as: ${plan.summary}`
    );

    const message = createMessage<PlanContent>({
      task_id: task.id,
      sender: this.name,
      recipient: 'coder',
      type: 'plan_response',
      content: plan,
    });

    return { message };
  }

  private plan(title: string, description: string): PlanContent {
    return {
      summary: `Implement "${title}" as a small, self-contained module with unit tests. ${description}`.trim(),
      acceptance_criteria: [
        'Implementation matches the task description',
        'Unit tests exist and cover the main behavior',
        'All tests pass',
        'No high/critical review issues remain',
      ],
      subtasks: ['Implement functionality', 'Write unit tests', 'Address review feedback if any'],
    };
  }
}
