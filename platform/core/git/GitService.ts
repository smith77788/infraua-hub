import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Thin wrapper around the git CLI, scoped to one repository directory
 * per instance. Every destructive operation (checkout that could drop
 * work, branch deletion, force-push) first checks the working tree is
 * clean so an agent can never silently discard someone else's changes.
 */
export class GitService {
  constructor(private readonly repoDir: string) {}

  private run(args: string[], timeoutMs = 30000): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.repoDir, timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      });
    });
  }

  static async initRepo(repoDir: string): Promise<GitService> {
    fs.mkdirSync(repoDir, { recursive: true });
    const git = new GitService(repoDir);
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      await git.run(['init', '-b', 'main']);
      await git.run(['config', 'user.email', 'factory@local']);
      await git.run(['config', 'user.name', 'AI Software Factory']);
      const readme = path.join(repoDir, 'README.md');
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, '# Project workspace\n');
      await git.run(['add', '.']);
      await git.run(['commit', '-m', 'chore: initialize repository']);
    }
    return git;
  }

  async isClean(): Promise<boolean> {
    const { stdout } = await this.run(['status', '--porcelain']);
    return stdout.trim().length === 0;
  }

  /** Throws if the working tree is dirty, to guard destructive operations. */
  async assertClean(operation: string): Promise<void> {
    if (!(await this.isClean())) {
      throw new Error(`Refusing to ${operation}: working tree has uncommitted changes.`);
    }
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--verify', branch]);
      return true;
    } catch {
      return false;
    }
  }

  async createTaskBranch(taskId: string, baseBranch = 'main'): Promise<string> {
    await this.assertClean('create a new branch');
    const branch = `task/${taskId}`;
    if (await this.branchExists(baseBranch)) {
      await this.run(['checkout', baseBranch]);
    }
    if (await this.branchExists(branch)) {
      await this.run(['checkout', branch]);
    } else {
      await this.run(['checkout', '-b', branch]);
    }
    return branch;
  }

  async checkout(branch: string): Promise<void> {
    await this.assertClean(`checkout ${branch}`);
    await this.run(['checkout', branch]);
  }

  async commitAll(message: string): Promise<boolean> {
    await this.run(['add', '-A']);
    if (await this.isClean()) return false;
    await this.run(['commit', '-m', message]);
    return true;
  }

  async mergeIntoBase(taskBranch: string, baseBranch = 'main'): Promise<void> {
    await this.assertClean('merge');
    await this.run(['checkout', baseBranch]);
    await this.run(['merge', '--no-ff', taskBranch, '-m', `Merge ${taskBranch} into ${baseBranch}`]);
  }

  async log(maxCount = 10): Promise<string[]> {
    const { stdout } = await this.run(['log', `-${maxCount}`, '--oneline']);
    return stdout.split('\n').filter(Boolean);
  }

  async diffStat(): Promise<string> {
    const { stdout } = await this.run(['diff', '--stat', 'HEAD']);
    return stdout;
  }
}
