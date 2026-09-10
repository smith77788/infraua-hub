import { Task } from './Task';

/**
 * Storage abstraction so the persistence backend can be swapped
 * (MVP ships FileTaskRepository; a Postgres-backed implementation
 * can be dropped in later without touching TaskService or callers).
 */
export interface TaskRepository {
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | null>;
  findAll(): Promise<Task[]>;
  delete(id: string): Promise<void>;
}
