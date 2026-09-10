import { Task } from '../../core/tasks/Task';
import { ReviewIssue } from '../../core/agents/Review';

export interface ImplementationInput {
  task: Task;
  workspaceDir: string;
  planSummary: string;
  /** Present when this call is a fix pass responding to a review. */
  reviewFeedback?: ReviewIssue[];
  attempt: number;
}

export interface ImplementationOutput {
  filesWritten: string[];
  summary: string;
}

/**
 * Backend-agnostic contract for "something that can write code". Swap
 * the adapter to change which coding agent does the work without
 * touching CoderAgent, the orchestrator, or the protocol.
 */
export interface CodingAgentAdapter {
  readonly name: string;
  implement(input: ImplementationInput): Promise<ImplementationOutput>;
}
