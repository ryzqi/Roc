import { execFile } from 'node:child_process';

export type RewriteExecution = {
  stdout: string;
  exitCode: number;
};

export type RewriteRunner = (binaryPath: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<RewriteExecution>;

export type RewriteResult = {
  rewritten: string | null;
  rtkArgs: string[] | null;
  exitCode: number;
};

export type RewriterOptions = {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runRewrite?: RewriteRunner;
};

const windowsRtkDeniedSubcommands = new Set(['ls']);

export class CommandRewriter {
  private readonly timeoutMs: number;
  private readonly runRewrite: RewriteRunner;

  constructor(
    private readonly binaryPath: string,
    options: RewriterOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.runRewrite =
      options.runRewrite === undefined
        ? (binaryPath, args, timeoutMs, signal) => defaultRunRewrite(binaryPath, args, timeoutMs, signal, options.environment)
        : options.runRewrite;
  }

  async rewrite(command: string, signal?: AbortSignal): Promise<RewriteResult> {
    try {
      const execution =
        signal === undefined
          ? await this.runRewrite(this.binaryPath, ['rewrite', command], this.timeoutMs)
          : await this.runRewrite(this.binaryPath, ['rewrite', command], this.timeoutMs, signal);
      return this.toRewriteResult(execution);
    } catch {
      if (signal?.aborted) {
        throw new Error('shell_execution_aborted');
      }
      return {
        rewritten: null,
        rtkArgs: null,
        exitCode: 1
      };
    }
  }

  private toRewriteResult(execution: RewriteExecution): RewriteResult {
    const rewritten = execution.stdout.trim();
    if ((execution.exitCode === 0 || execution.exitCode === 3) && rewritten.length > 0) {
      return {
        rewritten,
        rtkArgs: parseRtkArgs(rewritten),
        exitCode: execution.exitCode
      };
    }

    return {
      rewritten: null,
      rtkArgs: null,
      exitCode: execution.exitCode === 2 ? 2 : 1
    };
  }
}

export function parseRtkArgs(command: string): string[] | null {
  const parts = splitCommandLine(command);
  const executable = parts[0];
  if (executable === undefined) {
    return null;
  }
  const normalized = executable.toLowerCase();
  if (normalized !== 'rtk' && normalized !== 'rtk.exe') {
    return null;
  }
  return parts.slice(1);
}

export function isWindowsRtkDeniedSubcommand(args: readonly string[]): boolean {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === undefined) {
    return false;
  }
  return windowsRtkDeniedSubcommands.has(subcommand);
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return parts;
}

async function defaultRunRewrite(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv
): Promise<RewriteExecution> {
  return await new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      args,
      {
        encoding: 'utf8',
        env: environment,
        timeout: timeoutMs,
        signal,
        windowsHide: true
      },
      (error, stdout) => {
        if (error === null) {
          resolve({
            stdout,
            exitCode: 0
          });
          return;
        }

        if (typeof error === 'object' && error !== null && 'code' in error) {
          resolve({
            stdout,
            exitCode: typeof error.code === 'number' ? error.code : 1
          });
          return;
        }

        reject(error);
      }
    );
  });
}
