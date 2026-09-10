import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../../core/git/GitService';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

describe('GitService', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('initializes a repo with an initial commit', async () => {
    const git = await GitService.initRepo(repoDir);
    expect(await git.isClean()).toBe(true);
    const log = await git.log();
    expect(log.length).toBe(1);
  });

  it('creates an isolated task branch and commits changes onto it', async () => {
    const git = await GitService.initRepo(repoDir);
    const branch = await git.createTaskBranch('TASK-abc');
    expect(branch).toBe('task/TASK-abc');
    expect(await git.currentBranch()).toBe('task/TASK-abc');

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'hello');
    const committed = await git.commitAll('feat: add feature');
    expect(committed).toBe(true);
    expect(await git.isClean()).toBe(true);
  });

  it('refuses to checkout when the working tree is dirty', async () => {
    const git = await GitService.initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'uncommitted');
    await expect(git.checkout('main')).rejects.toThrow(/Refusing/);
  });

  it('merges a task branch back into main without losing history', async () => {
    const git = await GitService.initRepo(repoDir);
    await git.createTaskBranch('TASK-merge');
    fs.writeFileSync(path.join(repoDir, 'merged.txt'), 'content');
    await git.commitAll('feat: implement');

    await git.mergeIntoBase('task/TASK-merge', 'main');
    expect(await git.currentBranch()).toBe('main');
    expect(fs.existsSync(path.join(repoDir, 'merged.txt'))).toBe(true);
  });
});
