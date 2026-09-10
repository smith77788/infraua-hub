import { v4 as uuidv4 } from 'uuid';
import { ApprovalGate, CreateTaskInput, Task, TaskLogEntry, TaskPriority, TaskResult, TaskStatus } from './Task';
import { TaskRepository } from './TaskRepository';

const DEFAULT_MAX_ATTEMPTS = Number(process.env.MAX_FIX_ATTEMPTS ?? 3);

export class TaskService {
  constructor(private readonly repo: TaskRepository) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: `TASK-${uuidv4().slice(0, 8)}`,
      title: input.title,
      description: input.description,
      status: TaskStatus.NEW,
      priority: input.priority ?? TaskPriority.MEDIUM,
      created_at: now,
      updated_at: now,
      parent_task: input.parent_task ?? null,
      depends_on: input.depends_on ?? [],
      assigned_agent: null,
      repository: input.repository ?? null,
      branch: null,
      attempts: 0,
      max_attempts: input.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
      logs: [],
      result: null,
      pending_gate: null,
      approved_gates: [],
    };
    await this.repo.save(task);
    return task;
  }

  async get(id: string): Promise<Task | null> {
    return this.repo.findById(id);
  }

  async list(): Promise<Task[]> {
    return this.repo.findAll();
  }

  async areDependenciesSatisfied(task: Task): Promise<boolean> {
    for (const depId of task.depends_on) {
      const dep = await this.repo.findById(depId);
      if (!dep || dep.status !== TaskStatus.DONE) return false;
    }
    return true;
  }

  async setStatus(id: string, status: TaskStatus): Promise<Task> {
    const task = await this.requireTask(id);
    task.status = status;
    task.updated_at = new Date().toISOString();
    await this.repo.save(task);
    return task;
  }

  async assignAgent(id: string, agentName: string): Promise<Task> {
    const task = await this.requireTask(id);
    task.assigned_agent = agentName;
    task.updated_at = new Date().toISOString();
    await this.repo.save(task);
    return task;
  }

  async setBranch(id: string, repository: string, branch: string): Promise<Task> {
    const task = await this.requireTask(id);
    task.repository = repository;
    task.branch = branch;
    task.updated_at = new Date().toISOString();
    await this.repo.save(task);
    return task;
  }

  async incrementAttempts(id: string): Promise<Task> {
    const task = await this.requireTask(id);
    task.attempts += 1;
    task.updated_at = new Date().toISOString();
    await this.repo.save(task);
    return task;
  }

  async hasExceededAttempts(task: Task): Promise<boolean> {
    return task.attempts >= task.max_attempts;
  }

  async appendLog(id: string, actor: string, message: string): Promise<TaskLogEntry> {
    const task = await this.requireTask(id);
    const entry: TaskLogEntry = { timestamp: new Date().toISOString(), actor, message };
    task.logs.push(entry);
    task.updated_at = new Date().toISOString();
    await this.repo.save(task);
    return entry;
  }

  async setResult(id: string, result: TaskResult): Promise<Task> {
    const task = await this.requireTask(id);
    task.result = result;
    task.updated_at = new Date().toISOString();
    await this.repo.save(task);
    return task;
  }

  async setPendingGate(id: string, gate: ApprovalGate | null): Promise<Task> {
    const task = await this.requireTask(id);
    task.pending_gate = gate;
    task.updated_at = new Date().toISOString();
    await this.repo.save(task);
    return task;
  }

  async approveGate(id: string, gate: ApprovalGate): Promise<Task> {
    const task = await this.requireTask(id);
    if (!task.approved_gates.includes(gate)) task.approved_gates.push(gate);
    task.pending_gate = null;
    task.updated_at = new Date().toISOString();
    await this.repo.save(task);
    return task;
  }

  async createSubtask(parentId: string, input: CreateTaskInput): Promise<Task> {
    const parent = await this.requireTask(parentId);
    return this.create({ ...input, parent_task: parent.id });
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.repo.findById(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
}
