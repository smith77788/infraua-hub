import { Task } from '../tasks/Task';
import { AgentMessage } from './AgentMessage';

export type AgentRole = 'architect' | 'coder' | 'reviewer' | 'orchestrator';

export interface AgentExecutionContext {
  task: Task;
  workspaceDir: string;
  inbox: AgentMessage[];
}

export interface AgentExecutionResult<TContent = unknown> {
  message: AgentMessage<TContent>;
}

/**
 * Common contract every agent implements, regardless of which AI
 * provider (or mock) backs it. The orchestrator only ever depends on
 * this interface.
 */
export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole;
  readonly capabilities: string[];
  execute(context: AgentExecutionContext): Promise<AgentExecutionResult>;
}
