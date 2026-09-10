import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InMemoryTaskRepository } from '../../core/tasks/InMemoryTaskRepository';
import { TaskService } from '../../core/tasks/TaskService';
import { TaskStatus } from '../../core/tasks/Task';
import { Memory } from '../../core/memory/Memory';
import { EventBus, FactoryEvent } from '../../core/events/EventBus';
import { AutonomyMode } from '../../core/config/AutonomyMode';
import { Orchestrator } from '../../agents/orchestrator/Orchestrator';
import { afterEach, describe, expect, it } from 'bun:test';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-'));
}

describe('End-to-end: user task -> orchestrator -> architect -> coder -> tests -> reviewer -> DONE', () => {
  let workspaceRoot: string;

  afterEach(() => {
    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('drives a task through the full cycle in AUTO mode, self-healing a seeded bug', async () => {
    workspaceRoot = makeWorkspace();
    const taskService = new TaskService(new InMemoryTaskRepository());
    const memory = new Memory(path.join(workspaceRoot, '.memory'));
    const eventBus = new EventBus();
    const events: FactoryEvent[] = [];
    eventBus.on('event', (e: FactoryEvent) => events.push(e));

    const orchestrator = new Orchestrator(taskService, memory, eventBus, workspaceRoot, AutonomyMode.AUTO);

    const task = await taskService.create({
      title: 'Users REST API',
      description: 'Create a REST API for managing users.',
    });

    const final = await orchestrator.start(task.id);

    expect(final.status).toBe(TaskStatus.DONE);
    expect(final.result?.success).toBe(true);
    // The mock coder seeds a bug on the first pass, so this only reaches
    // DONE if the reviewer caught it and the fix loop actually ran.
    expect(final.attempts).toBeGreaterThanOrEqual(2);

    const allTasks = await taskService.list();
    const fixTasks = allTasks.filter((t) => t.parent_task === task.id);
    expect(fixTasks.length).toBeGreaterThanOrEqual(1);

    const eventTypes = events.filter((e) => e.task_id === task.id).map((e) => e.type);
    expect(eventTypes).toContain('plan_response');
    expect(eventTypes).toContain('review_response');

    const testFile = path.join(workspaceRoot, 'repos', 'default', 'test', 'users.test.js');
    expect(fs.existsSync(testFile)).toBe(true);
  }, 30000);

  it('pauses before merge in REVIEW_REQUIRED mode and resumes on approval', async () => {
    workspaceRoot = makeWorkspace();
    const taskService = new TaskService(new InMemoryTaskRepository());
    const memory = new Memory(path.join(workspaceRoot, '.memory'));
    const eventBus = new EventBus();

    const orchestrator = new Orchestrator(taskService, memory, eventBus, workspaceRoot, AutonomyMode.REVIEW_REQUIRED);
    const task = await taskService.create({ title: 'Users REST API', description: 'desc' });

    const paused = await orchestrator.start(task.id);
    expect(paused.status).toBe(TaskStatus.BLOCKED_ON_HUMAN);
    expect(paused.pending_gate).toBe('before_merge');

    const done = await orchestrator.approve(task.id);
    expect(done.status).toBe(TaskStatus.DONE);
  }, 30000);

  it('escalates to a human after exceeding max_attempts', async () => {
    workspaceRoot = makeWorkspace();
    const taskService = new TaskService(new InMemoryTaskRepository());
    const memory = new Memory(path.join(workspaceRoot, '.memory'));
    const eventBus = new EventBus();
    const orchestrator = new Orchestrator(taskService, memory, eventBus, workspaceRoot, AutonomyMode.AUTO);

    // max_attempts=1: the seeded first-attempt bug will fail review, and a
    // single attempt is not enough to reach the fix pass.
    const task = await taskService.create({ title: 'Users REST API', description: 'desc', max_attempts: 1 });
    const final = await orchestrator.start(task.id);

    expect(final.status).toBe(TaskStatus.BLOCKED_ON_HUMAN);
    expect(final.result?.success).toBe(false);
  }, 30000);
});
