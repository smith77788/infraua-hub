import { Task } from './Task';
import { TaskRepository } from './TaskRepository';

/** Used in unit tests to avoid touching the filesystem. */
export class InMemoryTaskRepository implements TaskRepository {
  private readonly store = new Map<string, Task>();

  async save(task: Task): Promise<void> {
    this.store.set(task.id, JSON.parse(JSON.stringify(task)));
  }

  async findById(id: string): Promise<Task | null> {
    const task = this.store.get(id);
    return task ? JSON.parse(JSON.stringify(task)) : null;
  }

  async findAll(): Promise<Task[]> {
    return Array.from(this.store.values())
      .map((t) => JSON.parse(JSON.stringify(t)))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
