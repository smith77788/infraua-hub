export enum TaskStatus {
  NEW = 'NEW',
  PLANNING = 'PLANNING',
  IMPLEMENTING = 'IMPLEMENTING',
  TESTING = 'TESTING',
  REVIEW = 'REVIEW',
  FIXING = 'FIXING',
  DONE = 'DONE',
  FAILED = 'FAILED',
  BLOCKED_ON_HUMAN = 'BLOCKED_ON_HUMAN',
}

export enum TaskPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export type ApprovalGate = 'before_implementation' | 'before_merge';

export interface TaskLogEntry {
  timestamp: string;
  actor: string;
  message: string;
}

export interface TaskResult {
  success: boolean;
  summary: string;
  artifacts?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  created_at: string;
  updated_at: string;
  parent_task: string | null;
  depends_on: string[];
  assigned_agent: string | null;
  repository: string | null;
  branch: string | null;
  attempts: number;
  max_attempts: number;
  logs: TaskLogEntry[];
  result: TaskResult | null;
  pending_gate: ApprovalGate | null;
  approved_gates: ApprovalGate[];
}

export interface CreateTaskInput {
  title: string;
  description: string;
  priority?: TaskPriority;
  parent_task?: string | null;
  depends_on?: string[];
  repository?: string | null;
  max_attempts?: number;
}
