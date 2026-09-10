import { Agent, AgentExecutionContext, AgentExecutionResult } from '../../core/agents/Agent';
import { createMessage } from '../../core/agents/AgentMessage';
import { Executor } from '../../core/execution/Executor';
import { ReviewResult } from '../../core/agents/Review';
import { Memory } from '../../core/memory/Memory';

/**
 * Runs the project's tests inside the isolated workspace and turns the
 * outcome into a structured ReviewResult. This is a real check (it
 * actually executes `node test/*.test.js`), not a scripted approval -
 * only the "AI judgement" part (deeper architecture/security review) is
 * mocked here, and can be swapped for a real Claude-backed adapter later.
 */
export class ReviewerAgent implements Agent {
  readonly id = 'reviewer-1';
  readonly name = 'Claude (Reviewer)';
  readonly role = 'reviewer' as const;
  readonly capabilities = ['test_execution', 'correctness_review', 'security_review'];

  constructor(private readonly memory: Memory) {}

  async execute(context: AgentExecutionContext): Promise<AgentExecutionResult<ReviewResult>> {
    const { task, workspaceDir } = context;
    const executor = new Executor({ workingDir: workspaceDir, allowedCommands: ['node'] });

    const result = await executor.run('node', ['test/users.test.js']);
    const review: ReviewResult = result.exitCode === 0
      ? { approved: true, issues: [], summary: 'All tests passed. No blocking issues found.' }
      : {
          approved: false,
          issues: [
            {
              severity: 'high',
              description: `Tests failed (exit code ${result.exitCode}): ${result.stderr.trim().slice(-500) || result.stdout.trim().slice(-500)}`,
              file: 'test/users.test.js',
            },
          ],
          summary: 'Tests failed - changes are not approved.',
        };

    this.memory.write(
      'agent_reports',
      `${task.id}-review-attempt-${task.attempts}`,
      `# Review for ${task.id} (attempt ${task.attempts})\n\nApproved: ${review.approved}\n\n${review.summary}\n`
    );
    if (!review.approved) {
      this.memory.write('failures', `${task.id}-attempt-${task.attempts}`, JSON.stringify(review, null, 2));
    }

    const message = createMessage<ReviewResult>({
      task_id: task.id,
      sender: this.name,
      recipient: 'orchestrator',
      type: 'review_response',
      content: review,
    });

    return { message };
  }
}
