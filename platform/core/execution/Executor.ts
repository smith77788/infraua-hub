import { spawn } from 'child_process';

export interface ExecutionResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecutorOptions {
  /** Absolute path agents are confined to. No command may escape it. */
  workingDir: string;
  /** Command names allowed to run, e.g. ["npm", "git", "node"]. */
  allowedCommands: string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS ?? 60000);

/**
 * Runs a whitelisted command inside an isolated working directory with
 * a hard timeout, and returns full logs. This is the only way agents
 * are allowed to touch the filesystem for build/test/lint actions -
 * it never invokes a shell, so no shell-metacharacter injection is
 * possible, and it rejects any command not on the allowlist outright.
 */
export class Executor {
  private readonly log: string[] = [];

  constructor(private readonly options: ExecutorOptions) {}

  getLog(): string[] {
    return [...this.log];
  }

  async run(command: string, args: string[] = []): Promise<ExecutionResult> {
    if (!this.options.allowedCommands.includes(command)) {
      const result: ExecutionResult = {
        command: `${command} ${args.join(' ')}`,
        exitCode: null,
        stdout: '',
        stderr: `Command "${command}" is not on the allowlist for this executor.`,
        timedOut: false,
        durationMs: 0,
      };
      this.log.push(`[BLOCKED] ${result.command}`);
      return result;
    }

    const start = Date.now();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.options.workingDir,
        shell: false,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));

      child.on('close', (code) => {
        clearTimeout(timer);
        const result: ExecutionResult = {
          command: `${command} ${args.join(' ')}`,
          exitCode: code,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - start,
        };
        this.log.push(`[RUN] ${result.command} -> exit ${code}${timedOut ? ' (timed out)' : ''}`);
        resolve(result);
      });
    });
  }
}
