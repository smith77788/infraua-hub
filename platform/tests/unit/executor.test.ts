import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Executor } from '../../core/execution/Executor';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

describe('Executor', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs an allowed command and captures output', async () => {
    const executor = new Executor({ workingDir: dir, allowedCommands: ['node'] });
    const result = await executor.run('node', ['-e', "console.log('hi')"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('blocks a command not on the allowlist without running it', async () => {
    const executor = new Executor({ workingDir: dir, allowedCommands: ['node'] });
    const result = await executor.run('rm', ['-rf', '/']);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/not on the allowlist/);
  });

  it('kills a command that exceeds its timeout', async () => {
    const executor = new Executor({ workingDir: dir, allowedCommands: ['node'], timeoutMs: 200 });
    const result = await executor.run('node', ['-e', 'setTimeout(() => {}, 5000)']);
    expect(result.timedOut).toBe(true);
  });
});
