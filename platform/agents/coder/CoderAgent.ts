import { Agent, AgentExecutionContext, AgentExecutionResult } from '../../core/agents/Agent';
import { createMessage } from '../../core/agents/AgentMessage';
import { GitService } from '../../core/git/GitService';
import { ReviewIssue } from '../../core/agents/Review';
import { CodingAgentAdapter } from './CodingAgentAdapter';
import { PlanContent } from '../architect/ArchitectAgent';

export interface ImplementationContent {
  filesWritten: string[];
  summary: string;
  committed: boolean;
}

/**
 * Coding agent facade. Delegates the actual code generation to a
 * CodingAgentAdapter (Mock today, Codex/other providers later) and is
 * responsible for the git side effects: committing whatever the adapter
 * produced onto the task's branch.
 */
export class CoderAgent implements Agent {
  readonly id = 'coder-1';
  readonly role = 'coder' as const;
  readonly capabilities = ['implementation', 'testing', 'commit'];

  constructor(private readonly adapter: CodingAgentAdapter, private readonly git: GitService) {}

  get name(): string {
    return `Codex (${this.adapter.name})`;
  }

  async execute(
    context: AgentExecutionContext,
    plan?: PlanContent,
    reviewFeedback?: ReviewIssue[],
    attempt = 0
  ): Promise<AgentExecutionResult<ImplementationContent>> {
    const { task, workspaceDir } = context;

    const output = await this.adapter.implement({
      task,
      workspaceDir,
      planSummary: plan?.summary ?? task.description,
      reviewFeedback,
      attempt,
    });

    const committed = await this.git.commitAll(
      reviewFeedback && reviewFeedback.length > 0
        ? `fix(${task.id}): ${output.summary}`
        : `feat(${task.id}): ${output.summary}`
    );

    const message = createMessage<ImplementationContent>({
      task_id: task.id,
      sender: this.name,
      recipient: 'reviewer',
      type: reviewFeedback ? 'fix_response' : 'implementation_response',
      content: { filesWritten: output.filesWritten, summary: output.summary, committed },
      artifacts: output.filesWritten.map((p) => ({ type: 'file' as const, path: p, content: '' })),
    });

    return { message };
  }
}
