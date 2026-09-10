import * as path from 'path';
import { TaskService } from '../../core/tasks/TaskService';
import { Task, TaskStatus } from '../../core/tasks/Task';
import { Memory } from '../../core/memory/Memory';
import { EventBus } from '../../core/events/EventBus';
import { GitService } from '../../core/git/GitService';
import { AutonomyMode, requiresHumanApproval } from '../../core/config/AutonomyMode';
import { ReviewResult } from '../../core/agents/Review';
import { ArchitectAgent } from '../architect/ArchitectAgent';
import { CoderAgent } from '../coder/CoderAgent';
import { MockCoderAdapter } from '../coder/adapters/MockCoderAdapter';
import { ReviewerAgent } from '../reviewer/ReviewerAgent';

/**
 * The state machine driving one task from NEW to DONE:
 *
 *   NEW -> PLANNING -> IMPLEMENTING -> TESTING -> REVIEW -> (FIXING -> TESTING -> REVIEW)* -> DONE
 *
 * It never talks to an AI provider directly - it only calls Agent
 * implementations through the shared interface, so architect/coder/
 * reviewer can each be swapped independently. A run pauses at
 * `BLOCKED_ON_HUMAN` when either the autonomy mode requires approval at
 * the current gate or the review/fix loop exceeds max_attempts; call
 * `approve()` to resume the former, or start a new task for the latter.
 *
 * Known MVP limitation: pending approvals are resumable across process
 * restarts (persisted on the Task), but the architect step is cheaply
 * re-run on every resume since the mock has no real API cost - a real
 * adapter should cache its plan instead. See docs/architecture.md.
 */
export class Orchestrator {
  constructor(
    private readonly taskService: TaskService,
    private readonly memory: Memory,
    private readonly eventBus: EventBus,
    private readonly workspaceRoot: string,
    private readonly mode: AutonomyMode,
    private readonly repoName: string = 'default'
  ) {}

  async start(taskId: string): Promise<Task> {
    return this.advance(taskId);
  }

  async approve(taskId: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (!task.pending_gate) {
      throw new Error(`Task ${taskId} has no pending approval gate.`);
    }
    await this.taskService.approveGate(taskId, task.pending_gate);
    await this.logEvent(task.id, 'human', `Approved gate: ${task.pending_gate}`, 'status_update');
    return this.advance(taskId);
  }

  private repoDir(): string {
    return path.join(this.workspaceRoot, 'repos', this.repoName);
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.taskService.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private async logEvent(taskId: string, actor: string, message: string, type: string): Promise<void> {
    await this.taskService.appendLog(taskId, actor, message);
    this.eventBus.publish({ task_id: taskId, actor, type, message });
  }

  async advance(taskId: string): Promise<Task> {
    let task = await this.requireTask(taskId);

    if (task.status === TaskStatus.DONE || task.status === TaskStatus.FAILED) {
      return task;
    }

    if (!(await this.taskService.areDependenciesSatisfied(task))) {
      task = await this.taskService.setStatus(taskId, TaskStatus.BLOCKED_ON_HUMAN);
      await this.logEvent(taskId, 'orchestrator', `Blocked: unmet dependencies [${task.depends_on.join(', ')}].`, 'status_update');
      return task;
    }

    const repoDir = this.repoDir();
    const git = await GitService.initRepo(repoDir);
    const architect = new ArchitectAgent(this.memory);
    const coder = new CoderAgent(new MockCoderAdapter(), git);
    const reviewer = new ReviewerAgent(this.memory);

    if (task.status === TaskStatus.NEW) {
      task = await this.taskService.setStatus(taskId, TaskStatus.PLANNING);
      await this.logEvent(taskId, 'orchestrator', 'Status -> PLANNING', 'status_update');
    }

    const branch = task.branch ?? (await git.createTaskBranch(task.id));
    if (!task.branch) {
      task = await this.taskService.setBranch(task.id, this.repoName, branch);
    } else if ((await git.currentBranch()) !== branch) {
      await git.checkout(branch);
    }

    const planMsg = await architect.execute({ task, workspaceDir: repoDir, inbox: [] });
    const plan = planMsg.message.content;
    await this.logEvent(task.id, architect.name, `Plan: ${plan.summary}`, 'plan_response');
    task = await this.taskService.assignAgent(task.id, architect.name);

    if (requiresHumanApproval(this.mode, 'before_implementation') && !task.approved_gates.includes('before_implementation')) {
      return this.pauseForGate(task.id, 'before_implementation', 'Awaiting human approval before implementation (MANUAL mode).');
    }

    // Resuming after the before_merge gate: implementation + review already
    // succeeded, skip straight to merging instead of redoing the work.
    if (task.approved_gates.includes('before_merge')) {
      return this.mergeAndFinish(task, git, branch);
    }

    let review: ReviewResult | null = null;
    for (;;) {
      task = await this.taskService.setStatus(task.id, task.attempts === 0 ? TaskStatus.IMPLEMENTING : TaskStatus.FIXING);
      await this.logEvent(task.id, 'orchestrator', `Status -> ${task.status} (attempt ${task.attempts + 1}/${task.max_attempts})`, 'status_update');

      const implResult = await coder.execute(
        { task, workspaceDir: repoDir, inbox: [] },
        plan,
        review?.issues,
        task.attempts
      );
      await this.logEvent(task.id, coder.name, implResult.message.content.summary, implResult.message.type);

      task = await this.taskService.setStatus(task.id, TaskStatus.TESTING);
      await this.logEvent(task.id, 'orchestrator', 'Status -> TESTING', 'status_update');

      task = await this.taskService.setStatus(task.id, TaskStatus.REVIEW);
      const reviewMsg = await reviewer.execute({ task, workspaceDir: repoDir, inbox: [] });
      review = reviewMsg.message.content;
      await this.logEvent(task.id, reviewer.name, review.summary, 'review_response');

      task = await this.taskService.incrementAttempts(task.id);

      if (review.approved) break;

      if (await this.taskService.hasExceededAttempts(task)) {
        task = await this.taskService.setStatus(task.id, TaskStatus.BLOCKED_ON_HUMAN);
        task = await this.taskService.setResult(task.id, {
          success: false,
          summary: `Blocked after ${task.attempts} attempts: ${review.issues.map((i) => i.description).join('; ')}`,
        });
        await this.logEvent(task.id, 'orchestrator', `Max attempts (${task.max_attempts}) reached without approval. Escalating to a human.`, 'status_update');
        return task;
      }

      await this.taskService.createSubtask(task.id, {
        title: `Fix issues found in ${task.id} (attempt ${task.attempts})`,
        description: review.issues.map((i) => `[${i.severity}] ${i.description}`).join('\n'),
        priority: task.priority,
      });
      await this.logEvent(task.id, 'orchestrator', `Created fix task for ${review.issues.length} issue(s).`, 'status_update');
    }

    await this.taskService.setResult(task.id, { success: true, summary: review.summary });

    if (requiresHumanApproval(this.mode, 'before_merge') && !task.approved_gates.includes('before_merge')) {
      return this.pauseForGate(task.id, 'before_merge', 'Awaiting human approval before merging to main (REVIEW_REQUIRED/MANUAL mode).');
    }

    return this.mergeAndFinish(task, git, branch);
  }

  private async pauseForGate(taskId: string, gate: 'before_implementation' | 'before_merge', reason: string): Promise<Task> {
    await this.taskService.setPendingGate(taskId, gate);
    const task = await this.taskService.setStatus(taskId, TaskStatus.BLOCKED_ON_HUMAN);
    await this.logEvent(taskId, 'orchestrator', reason, 'status_update');
    return task;
  }

  private async mergeAndFinish(task: Task, git: GitService, branch: string): Promise<Task> {
    await git.mergeIntoBase(branch);
    await this.logEvent(task.id, 'orchestrator', `Merged ${branch} into main.`, 'status_update');

    const previousSummary = task.result?.summary ?? 'Completed.';
    task = await this.taskService.setResult(task.id, { success: true, summary: `Task completed and merged. ${previousSummary}` });
    task = await this.taskService.setStatus(task.id, TaskStatus.DONE);
    await this.logEvent(task.id, 'orchestrator', 'Status -> DONE', 'status_update');
    return task;
  }
}
