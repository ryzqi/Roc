import { execFileSync, spawn } from 'node:child_process';
import type { RocHookCommandInput, RocHookCommandOutput } from '../../../shared/types';
import { HookCommandOutputSchema } from './schema';

const maxOutputBytes = 64 * 1024;

export type HookCommandRunRequest = {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  input: RocHookCommandInput;
};

export type HookCommandRunResult =
  | {
      status: 'completed';
      durationMs: number;
      stdout: string;
      stderr: string;
      output: RocHookCommandOutput;
    }
  | {
      status: 'failed';
      durationMs: number;
      stdout: string;
      stderr: string;
      error: string;
    };

export class HookCommandRunner {
  async run(request: HookCommandRunRequest): Promise<HookCommandRunResult> {
    const startedAt = Date.now();
    if (isVirtualHookCwd(request.cwd)) {
      return {
        status: 'failed',
        durationMs: 0,
        stdout: '',
        stderr: '',
        error: 'hook_cwd_virtual_path'
      };
    }
    if (request.signal?.aborted === true) {
      return {
        status: 'failed',
        durationMs: 0,
        stdout: '',
        stderr: '',
        error: 'hook_command_aborted'
      };
    }
    return await new Promise<HookCommandRunResult>((resolve) => {
      const child = spawn(request.command, {
        cwd: request.cwd,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        request.signal?.removeEventListener('abort', abort);
        terminateProcessTree(child);
        resolve({
          status: 'failed',
          durationMs: Date.now() - startedAt,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          error: 'hook_command_timeout'
        });
      }, request.timeoutSeconds * 1000);
      const abort = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        terminateProcessTree(child);
        resolve({
          status: 'failed',
          durationMs: Date.now() - startedAt,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          error: 'hook_command_aborted'
        });
      };
      if (request.signal?.aborted === true) {
        abort();
      } else {
        request.signal?.addEventListener('abort', abort, { once: true });
      }

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout = truncateOutput(stdout + chunkToString(chunk));
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = truncateOutput(stderr + chunkToString(chunk));
      });
      child.stdin.on('error', () => undefined);
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', abort);
        resolve({
          status: 'failed',
          durationMs: Date.now() - startedAt,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          error: error.message
        });
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', abort);
        const trimmedStdout = stdout.trim();
        if (code !== 0) {
          resolve({
            status: 'failed',
            durationMs: Date.now() - startedAt,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            error: `hook_command_exit_${code === null ? 'unknown' : code}`
          });
          return;
        }
        if (trimmedStdout.length === 0) {
          resolve({
            status: 'completed',
            durationMs: Date.now() - startedAt,
            stdout: '',
            stderr: truncateOutput(stderr),
            output: { action: 'continue' }
          });
          return;
        }
        try {
          resolve({
            status: 'completed',
            durationMs: Date.now() - startedAt,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            output: HookCommandOutputSchema.parse(JSON.parse(trimmedStdout))
          });
        } catch (error) {
          resolve({
            status: 'failed',
            durationMs: Date.now() - startedAt,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            error: `hook_output_json_invalid: ${error instanceof Error ? error.message : String(error)}`
          });
        }
      });
      child.stdin.end(JSON.stringify(request.input));
    });
  }
}

export function isVirtualHookCwd(cwd: string): boolean {
  const normalized = cwd.replaceAll('\\', '/');
  return (
    normalized === '/workspace' ||
    normalized.startsWith('/workspace/') ||
    normalized === '/memory' ||
    normalized.startsWith('/memory/') ||
    normalized === '/skills' ||
    normalized.startsWith('/skills/')
  );
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      child.kill();
    }
    return;
  }
  // Non-Windows fallback signals only the direct child; Windows uses taskkill /t for process-tree cleanup.
  child.kill();
}

function truncateOutput(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxOutputBytes) {
    return value;
  }
  return `${buffer.subarray(0, maxOutputBytes).toString('utf8')}\n[truncated]`;
}

function chunkToString(chunk: Buffer | string): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  return chunk.toString('utf8');
}
