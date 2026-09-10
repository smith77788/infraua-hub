import { InMemoryTaskRepository } from '../../core/tasks/InMemoryTaskRepository';
import { TaskService } from '../../core/tasks/TaskService';
import { TaskStatus } from '../../core/tasks/Task';
import { beforeEach, describe, expect, it } from 'bun:test';

describe('TaskService', () => {
  let service: TaskService;

  beforeEach(() => {
    service = new TaskService(new InMemoryTaskRepository());
  });

  it('creates a task with sane defaults', async () => {
    const task = await service.create({ title: 'Do X', description: 'desc' });
    expect(task.id).toMatch(/^TASK-/);
    expect(task.status).toBe(TaskStatus.NEW);
    expect(task.attempts).toBe(0);
    expect(task.depends_on).toEqual([]);
  });

  it('reports unmet dependencies until the dependency is DONE', async () => {
    const dep = await service.create({ title: 'Dependency', description: 'd' });
    const task = await service.create({ title: 'Dependent', description: 'd', depends_on: [dep.id] });

    expect(await service.areDependenciesSatisfied(task)).toBe(false);

    await service.setStatus(dep.id, TaskStatus.DONE);
    const refreshed = (await service.get(task.id))!;
    expect(await service.areDependenciesSatisfied(refreshed)).toBe(true);
  });

  it('tracks attempts against max_attempts', async () => {
    const task = await service.create({ title: 'T', description: 'd', max_attempts: 2 });
    expect(await service.hasExceededAttempts(task)).toBe(false);
    await service.incrementAttempts(task.id);
    const after1 = (await service.get(task.id))!;
    expect(await service.hasExceededAttempts(after1)).toBe(false);
    await service.incrementAttempts(task.id);
    const after2 = (await service.get(task.id))!;
    expect(await service.hasExceededAttempts(after2)).toBe(true);
  });

  it('records approval gates', async () => {
    const task = await service.create({ title: 'T', description: 'd' });
    await service.setPendingGate(task.id, 'before_merge');
    let updated = (await service.get(task.id))!;
    expect(updated.pending_gate).toBe('before_merge');

    await service.approveGate(task.id, 'before_merge');
    updated = (await service.get(task.id))!;
    expect(updated.pending_gate).toBeNull();
    expect(updated.approved_gates).toContain('before_merge');
  });

  it('creates subtasks linked to their parent', async () => {
    const parent = await service.create({ title: 'Parent', description: 'd' });
    const child = await service.createSubtask(parent.id, { title: 'Child', description: 'd' });
    expect(child.parent_task).toBe(parent.id);
  });
});
