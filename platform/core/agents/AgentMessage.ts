/**
 * Structured communication protocol between agents. Every agent-to-agent
 * exchange in the system uses this shape instead of free-form text, so
 * new agents can be added without renegotiating how they talk to each
 * other. See docs/protocol.md.
 */
export type AgentMessageType =
  | 'plan_request'
  | 'plan_response'
  | 'implementation_request'
  | 'implementation_response'
  | 'review_request'
  | 'review_response'
  | 'fix_request'
  | 'fix_response'
  | 'status_update';

export interface Artifact {
  type: 'file' | 'diff' | 'log' | 'report';
  path?: string;
  content: string;
}

export interface AgentMessage<TContent = unknown> {
  task_id: string;
  sender: string;
  recipient: string;
  type: AgentMessageType;
  content: TContent;
  artifacts: Artifact[];
  constraints: string[];
  timestamp: string;
}

export function createMessage<TContent>(
  params: Omit<AgentMessage<TContent>, 'timestamp' | 'artifacts' | 'constraints'> &
    Partial<Pick<AgentMessage<TContent>, 'artifacts' | 'constraints'>>
): AgentMessage<TContent> {
  return {
    ...params,
    artifacts: params.artifacts ?? [],
    constraints: params.constraints ?? [],
    timestamp: new Date().toISOString(),
  };
}
