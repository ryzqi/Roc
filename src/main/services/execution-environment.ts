import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { terminateProcessTreeWithRetry } from './process-tree';

export type IsolationProfile = 'isolated_read' | 'isolated_write';
export type EnvironmentCommand = {
  file: string;
  args: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  input?: string;
  requireSuccessfulExit?: boolean;
};
export type EnvironmentResult = { stdout: string; stderr: string; exitCode: number };
export type ExecutionEnvironment = {
  readonly profile: IsolationProfile;
  readonly root: string;
  execute(command: EnvironmentCommand): Promise<EnvironmentResult>;
  readFile(path: string, signal?: AbortSignal): Promise<string>;
  writeFile(path: string, content: string, signal?: AbortSignal): Promise<void>;
  dispose(): void;
};

/** Explicit fail-closed macOS provider. Shell, descendants and file operations use the same sandbox. */
export class MacOsIsolatedEnvironment implements ExecutionEnvironment {
  readonly root: string;
  readonly profile: IsolationProfile;
  private readonly policy: string;
  private readonly temporary: string;
  private readonly workspaceIdentity: { dev: string; ino: string };

  constructor(
    root: string,
    profile: IsolationProfile = 'isolated_write',
    expectedWorkspaceIdentity?: { dev: string; ino: string }
  ) {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('isolated_environment_unavailable');
    this.root = realpathSync(root);
    const rootStat = statSync(this.root);
    if (!rootStat.isDirectory()) throw new Error('isolated_environment_root_not_directory');
    this.workspaceIdentity = { dev: String(rootStat.dev), ino: String(rootStat.ino) };
    if (expectedWorkspaceIdentity !== undefined && (expectedWorkspaceIdentity.dev !== this.workspaceIdentity.dev || expectedWorkspaceIdentity.ino !== this.workspaceIdentity.ino)) {
      throw new Error('isolated_environment_workspace_identity_changed');
    }
    this.profile = profile;
    this.temporary = realpathSync(mkdtempSync(join(tmpdir(), 'roc-isolated-')));
    chmodSync(this.temporary, 0o700);
    const quote = (value: string) => JSON.stringify(value);
    const workspaceWriteRule = profile === 'isolated_write'
      ? `(allow file-read* file-write* file-map-executable (subpath ${quote(this.root)}))`
      : `(allow file-read* file-map-executable (subpath ${quote(this.root)}))`;
    // system.sb supplies this OS version's dyld/syscall rules. User-installed system paths stay outside the allowlist.
    this.policy = `(version 1)(deny default)(import "system.sb")
      (allow process-fork)
      (allow process-exec (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") (subpath "/usr/libexec"))
      (allow sysctl-read file-read-metadata)
      (deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))
      (allow file-read* file-map-executable (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/libexec") (subpath "/usr/share"))
      (deny file-read* file-write* file-map-executable (subpath "/usr/local"))
      ${workspaceWriteRule}
      (allow file-read* file-write* (subpath ${quote(this.temporary)}))
      (allow file-read* file-write-data (literal "/dev/null") (literal "/dev/urandom"))
      (allow signal (target self))`;
  }

  async execute(command: EnvironmentCommand): Promise<EnvironmentResult> {
    command.signal?.throwIfAborted();
    const timeout = command.timeoutMs ?? 30000;
    const outputLimit = command.maxOutputBytes ?? 1024 * 1024;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120000) throw new Error('isolated_environment_deadline_invalid');
    if (!Number.isInteger(outputLimit) || outputLimit <= 0 || outputLimit > 1024 * 1024) throw new Error('isolated_environment_output_limit_invalid');
    if (Buffer.byteLength(command.input ?? '') > 1024 * 1024) throw new Error('isolated_environment_input_limit');
    const cwd = command.cwd === undefined ? this.root : this.resolveWorkspacePath(command.cwd);
    this.assertWorkspaceIdentity();
    return new Promise((accept, reject) => {
      this.assertWorkspaceIdentity();
      const child = spawn('/usr/bin/sandbox-exec', ['-p', this.policy, command.file, ...command.args], {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.temporary, TMPDIR: this.temporary, LANG: 'en_US.UTF-8' }
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let finished = false;
      let stopPromise: Promise<Error | undefined> | undefined;
      const stop = (): Promise<Error | undefined> => {
        if (stopPromise !== undefined) return stopPromise;
        stopPromise = terminateProcessTreeWithRetry(child).then(
          () => undefined,
          (error: unknown) => new Error('isolated_environment_cleanup_failed', { cause: error })
        );
        return stopPromise;
      };
      const finish = async (error?: Error, exitCode = 1) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        command.signal?.removeEventListener('abort', abort);
        // Preserve a command's primary failure; tree cleanup is reported if it is the only failure.
        const cleanupFailure = await stop();
        const commandFailure = error ?? (command.requireSuccessfulExit && exitCode !== 0
          ? new Error(`isolated_environment_command_failed:${exitCode}:${stderr}`)
          : undefined);
        const failure = commandFailure !== undefined && cleanupFailure !== undefined
          ? new AggregateError([commandFailure, cleanupFailure], commandFailure.message, { cause: commandFailure })
          : commandFailure ?? cleanupFailure;
        if (failure !== undefined) reject(failure);
        else accept({ stdout, stderr, exitCode });
      };
      const abort = () => { void finish(new Error('isolated_environment_aborted')); };
      const deadline = setTimeout(() => { void finish(new Error('isolated_environment_deadline')); }, timeout);
      command.signal?.addEventListener('abort', abort, { once: true });
      if (command.signal?.aborted) abort();
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > outputLimit) {
          void finish(new Error('isolated_environment_output_limit'));
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') void finish(error);
      });
      child.on('error', (error) => { void finish(error); });
      child.on('exit', () => { void stop(); });
      child.on('close', (code) => { void finish(undefined, code ?? 1); });
      child.stdin.end(command.input);
    });
  }

  async readFile(path: string, signal?: AbortSignal): Promise<string> {
    let result: EnvironmentResult;
    try {
      result = await this.execute({ file: '/bin/cat', args: [this.path(path)], signal, requireSuccessfulExit: true });
    } catch (error) {
      throw new Error(`isolated_environment_read_failed:${errorMessage(error)}`, { cause: error });
    }
    if (result.exitCode !== 0) throw new Error(`isolated_environment_read_failed:${result.stderr}`);
    return result.stdout;
  }

  async writeFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
    if (this.profile !== 'isolated_write') throw new Error('isolated_environment_read_only');
    let result: EnvironmentResult;
    try {
      result = await this.execute({ file: '/bin/sh', args: ['-c',
        `umask 077; temp="$1.roc-$$"; trap 'rm -f "$temp"' EXIT; (set -C; cat > "$temp") && mv -f "$temp" "$1"`, 'roc-write', this.path(path)], input: content, signal, requireSuccessfulExit: true });
    } catch (error) {
      throw new Error(`isolated_environment_write_failed:${errorMessage(error)}`, { cause: error });
    }
    if (result.exitCode !== 0) throw new Error(`isolated_environment_write_failed:${result.stderr}`);
  }

  dispose(): void {
    rmSync(this.temporary, { recursive: true, force: true });
  }

  private assertWorkspaceIdentity(): void {
    const canonicalRoot = realpathSync(this.root);
    const stat = statSync(canonicalRoot);
    if (canonicalRoot !== this.root || String(stat.dev) !== this.workspaceIdentity.dev || String(stat.ino) !== this.workspaceIdentity.ino) {
      throw new Error('isolated_environment_workspace_identity_changed');
    }
  }

  private path(path: string): string {
    const target = resolve(this.root, path);
    this.assertInsideRoot(target);
    return target;
  }

  private resolveWorkspacePath(path: string): string {
    const target = realpathSync(resolve(this.root, path));
    this.assertInsideRoot(target);
    return target;
  }

  private assertInsideRoot(target: string): void {
    const child = relative(this.root, target);
    if (child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) {
      throw new Error('isolated_environment_path_outside');
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
