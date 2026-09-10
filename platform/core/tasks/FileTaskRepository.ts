import * as fs from 'fs';
import * as path from 'path';
import { Task } from './Task';
import { TaskRepository } from './TaskRepository';

/**
 * Simple, dependency-free JSON-file storage. Each task is one file.
 * Chosen for the MVP over standing up Postgres: it needs zero
 * infrastructure to run or test, and the TaskRepository interface
 * means a PostgresTaskRepository can replace it later with no
 * changes anywhere else (see docs/architecture.md, "Storage").
 */
export class FileTaskRepository implements TaskRepository {
  constructor(private readonly baseDir: string) {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(id: string): string {
    return path.join(this.baseDir, `${id}.json`);
  }

  async save(task: Task): Promise<void> {
    fs.writeFileSync(this.filePath(task.id), JSON.stringify(task, null, 2), 'utf-8');
  }

  async findById(id: string): Promise<Task | null> {
    const file = this.filePath(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Task;
  }

  async findAll(): Promise<Task[]> {
    if (!fs.existsSync(this.baseDir)) return [];
    const files = fs.readdirSync(this.baseDir).filter((f) => f.endsWith('.json'));
    const tasks = files.map((f) => JSON.parse(fs.readFileSync(path.join(this.baseDir, f), 'utf-8')) as Task);
    return tasks.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async delete(id: string): Promise<void> {
    const file = this.filePath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
