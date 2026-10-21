import { spawn } from 'node:child_process';
import { realpathSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { terminateProcessTree } from './process-tree';

export type EnvironmentCommand = { file: string; args: readonly string[]; signal?: AbortSignal; timeoutMs?: number; input?: string };
export type EnvironmentResult = { stdout: string; stderr: string; exitCode: number };
export type ExecutionEnvironment = {
  readonly profile: 'isolated';
  readonly root: string;
  execute(command: EnvironmentCommand): Promise<EnvironmentResult>;
  readFile(path: string, signal?: AbortSignal): Promise<string>;
  writeFile(path: string, content: string, signal?: AbortSignal): Promise<void>;
};

/** Explicit fail-closed macOS provider. Shell, descendants and file operations use the same sandbox. */
export class MacOsIsolatedEnvironment implements ExecutionEnvironment {
  readonly profile = 'isolated';
  readonly root: string;
  private readonly policy: string;
  private readonly temporary: string;

  constructor(root: string) {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('isolated_environment_unavailable');
    this.root = realpathSync(root);
    this.temporary = join(this.root, '.roc-probe-tmp');
    mkdirSync(this.temporary, { recursive: true, mode: 0o700 });
    if (realpathSync(this.temporary) !== this.temporary) throw new Error('isolated_environment_temp_symlink');
    // system.sb supplies this OS version's dyld/syscall rules; no network or external user-file access.
    const quote = (value: string) => JSON.stringify(value);
    this.policy = `(version 1)(deny default)(import "system.sb")
      (allow process* sysctl-read file-read-metadata)
      (deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))
      (allow file-read* file-map-executable (subpath "/bin") (subpath "/sbin") (subpath "/usr"))
      (allow file-read* file-write* file-map-executable (subpath ${quote(this.root)}))
      (allow file-read* file-write-data (literal "/dev/null") (literal "/dev/urandom"))
      (allow signal (target self))`;
  }

  async execute(command: EnvironmentCommand): Promise<EnvironmentResult> {
    command.signal?.throwIfAborted();
    const timeout = command.timeoutMs ?? 30000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120000) throw new Error('isolated_environment_deadline_invalid');
    if (Buffer.byteLength(command.input ?? '') > 1024 * 1024) throw new Error('isolated_environment_input_limit');
    return new Promise((accept, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', this.policy, command.file, ...command.args], {
        cwd: this.root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.root, TMPDIR: this.temporary, LANG: 'en_US.UTF-8' }
      });
      let stdout = '', stderr = '', bytes = 0, finished = false, stopped = false;
      let cleanupError: Error | undefined;
      const stop = () => {
        if (stopped) return cleanupError;
        stopped = true;
        try { terminateProcessTree(child); } catch (error) { cleanupError = new Error('isolated_environment_cleanup_failed', { cause: error }); }
        return cleanupError;
      };
      const finish = (error?: Error, exitCode = 1) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        command.signal?.removeEventListener('abort', abort);
        // Even successful parents may leave background descendants. Never retain them between probes.
        const cleanupFailure = stop();
        const failure = cleanupFailure ?? error;
        if (failure !== undefined) reject(failure); else accept({ stdout, stderr, exitCode });
      };
      const abort = () => finish(new Error('isolated_environment_aborted'));
      const deadline = setTimeout(() => finish(new Error('isolated_environment_deadline')), timeout);
      command.signal?.addEventListener('abort', abort, { once: true });
      if (command.signal?.aborted) abort();
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { finish(new Error('isolated_environment_output_limit')); return; }
        if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', chunk => append('stdout', chunk));
      child.stderr.on('data', chunk => append('stderr', chunk));
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error); });
      child.on('error', error => finish(error));
      child.on('exit', () => stop());
      child.on('close', code => finish(undefined, code ?? 1));
      child.stdin.end(command.input);
    });
  }

  async readFile(path: string, signal?: AbortSignal): Promise<string> {
    const result = await this.execute({ file: '/bin/cat', args: [this.path(path)], signal });
    if (result.exitCode !== 0) throw new Error(`isolated_environment_read_failed:${result.stderr}`);
    return result.stdout;
  }

  async writeFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
    const result = await this.execute({ file: '/bin/sh', args: ['-c',
      `umask 077; temp="$1.roc-$$"; trap 'rm -f "$temp"' EXIT; (set -C; cat > "$temp") && mv -f "$temp" "$1"`, 'roc-write', this.path(path)], input: content, signal });
    if (result.exitCode !== 0) throw new Error(`isolated_environment_write_failed:${result.stderr}`);
  }

  private path(path: string): string {
    const target = resolve(this.root, path);
    const child = relative(this.root, target);
    if (child === '' || child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('isolated_environment_path_outside');
    return target;
  }
}
