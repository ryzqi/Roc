import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { terminateProcessTreeWithRetry } from '../../../src/main/services/process-tree';
import { qualityHash, deepFreeze } from '../../runtime/agent-task-view';
import { QualityExecutionFailure, type QualityExecutor, type QualityExecutorBinding } from './runner';

export type QualityWorkerArtifact = {
  path: string; sha256: string; commitSha: string;
  nodeModulesPath: string; lockfilePath: string; lockfileSha256: string; nodeVersion: string;
};
export type QualityHostTransport = {
  providerId: string;
  complete(input: { body: Record<string, unknown>; signal: AbortSignal }):
    Promise<{ body: unknown }>;
};
export function qualityIsolationHash(): string {
  return qualityHash({ version: 2, platform: 'macOS-sandbox-exec', network: 'deny',
    filesystem: 'worker-root-and-runtime-dependencies; explicit-evaluator-deny',
    processes: 'node-only', transport: 'stdio-host', output: 'application-terminal-response' });
}
export function qualityApplicationEnvironmentHash(workers: Record<'baseline' | 'candidate', QualityWorkerArtifact>, protectedPaths: string[]): string {
  return qualityHash({ workers, protectedPaths: protectedPaths.map(path => realpathSync(path)).sort() });
}
export function createApplicationQualityExecutor(options: {
  binding: QualityExecutorBinding; workers: Record<'baseline' | 'candidate', QualityWorkerArtifact>;
  artifactsRoot: string; transport: QualityHostTransport;
  protectedPaths: string[];
  isolationProbePaths?: string[]; isolationProbePort?: number;
}): QualityExecutor {
  const input = { ...options, binding: Object.freeze({ ...options.binding }),
    workers: deepFreeze(structuredClone(options.workers)), transport: Object.freeze({ ...options.transport }),
    protectedPaths: options.protectedPaths.map(path => realpathSync(path)),
    isolationProbePaths: [...(options.isolationProbePaths ?? [])] };
  if (process.platform !== 'darwin') throw new Error('quality_application_isolation_unavailable');
  if (input.protectedPaths.length === 0) throw new Error('quality_application_evaluator_paths_required');
  if (input.workers.baseline.lockfileSha256 !== input.workers.candidate.lockfileSha256) {
    throw new Error('quality_application_dependency_versions_differ');
  }
  if (input.binding.isolationHash !== qualityIsolationHash() || input.binding.isolation !== 'process-files-tools'
    || input.binding.providerId !== input.transport.providerId) {
    throw new Error('quality_application_binding_invalid');
  }
  for (const arm of ['baseline', 'candidate'] as const) {
    const worker = input.workers[arm];
    if (worker.commitSha !== input.binding[`${arm}CommitSha`]
      || worker.nodeVersion !== process.version
      || createHash('sha256').update(readFileSync(worker.path)).digest('hex') !== worker.sha256
      || createHash('sha256').update(readFileSync(worker.lockfilePath)).digest('hex') !== worker.lockfileSha256) {
      throw new Error('quality_application_worker_changed');
    }
  }
  // Bundle identity is part of the frozen environment, never inferred from the current checkout.
  if (input.binding.environmentHash !== qualityApplicationEnvironmentHash(input.workers, input.protectedPaths)) {
    throw new Error('quality_application_environment_changed');
  }
  return {
    binding: Object.freeze({ ...input.binding }),
    async execute(view, context) {
      const trial = join(input.artifactsRoot, createHash('sha256').update(context.trialId).digest('hex'));
      mkdirSync(trial, { mode: 0o700 }); // Existing state blocks automatic replay.
      const root = join(trial, 'worker');
      mkdirSync(root, { mode: 0o700 });
      const worker = input.workers[context.arm];
      const workerBytes = readFileSync(worker.path);
      if (createHash('sha256').update(workerBytes).digest('hex') !== worker.sha256
        || createHash('sha256').update(readFileSync(worker.lockfilePath)).digest('hex') !== worker.lockfileSha256) {
        throw new QualityExecutionFailure('state', 'executor_integrity_changed');
      }
      const node = realpathSync(process.execPath);
      const modules = realpathSync(worker.nodeModulesPath);
      const trialWorker = join(root, 'application-worker.mjs');
      writeFileSync(trialWorker, workerBytes, { mode: 0o400 });
      writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', { mode: 0o400 });
      symlinkSync(modules, join(root, 'node_modules'));
      const quote = (value: string) => JSON.stringify(realpathSync(value));
      const policy = `(version 1)(deny default)(import "system.sb")
        (deny file-read* file-write* ${input.protectedPaths.map(path => `(subpath ${quote(path)})`).join(' ')})
        (allow process-fork)(allow process-exec (literal ${quote(node)}))
        (allow sysctl-read file-read-metadata)
        (deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))
        (allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/usr/share")
          (subpath "/System/Library") (subpath "/opt/homebrew/opt")
          (subpath "/opt/homebrew/Cellar") (subpath ${quote(modules)})
          )
        (allow file-read* file-write* file-map-executable (subpath ${quote(root)}))
        (allow file-read* file-write-data (literal "/dev/null") (literal "/dev/urandom"))
        (allow signal (target self))`;
      const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, node, trialWorker], {
        cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8', OPENSSL_CONF: '/dev/null',
          LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' }
      });
      const close = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code));
      });
      // Consume close rejection even when another boundary fails first.
      void close.catch(() => {});
      let cleanup: Promise<void> | undefined;
      const terminate = () => {
        cleanup ??= terminateProcessTreeWithRetry(child);
        void cleanup.catch(() => {});
        return cleanup;
      };
      const abort = () => { void terminate(); };
      context.signal.addEventListener('abort', abort, { once: true });
      let bytes = 0;
      let output: string | null = null;
      let resultSeen = false;
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        stderr += chunk.toString();
        if (bytes <= 1024 * 1024) appendFileSync(join(trial, 'stderr.log'), chunk, { mode: 0o600 });
        if (bytes > 1024 * 1024) abort();
      });
      child.stdin.on('error', () => abort());
      const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
      const lines = createInterface({ input: child.stdout });
      try {
        context.signal.throwIfAborted();
        send({ view, providerId: input.binding.providerId,
          modelId: input.binding[`${context.arm}ModelId`], temperature: input.binding.temperature,
          contextWindowTokens: 65536, maxOutputTokens: 4096,
          isolationProbePaths: input.isolationProbePaths ?? [],
          isolationProbePort: input.isolationProbePort ?? null });
        for await (const line of lines) {
          bytes += Buffer.byteLength(line);
          if (bytes > 1024 * 1024) throw new QualityExecutionFailure('infra');
          appendFileSync(join(trial, 'transcript.jsonl'), `${line}\n`, { mode: 0o600 });
          context.signal.throwIfAborted();
          const message = JSON.parse(line);
          if (message.type === 'request') {
            if (resultSeen
              || message.body.model !== input.binding[`${context.arm}ModelId`]
              || message.body.temperature !== input.binding.temperature
              || message.body.stream !== false || message.body.max_tokens !== 4096
              || message.requestHash !== qualityHash(message.body)) {
              throw new QualityExecutionFailure('policy', 'executor_request_policy_violated');
            }
            await context.recordRequest({ requestHash: message.requestHash });
            context.signal.throwIfAborted();
            const response = await input.transport.complete({
              body: message.body, signal: context.signal
            }).catch(error => {
              if (context.signal.aborted || (error instanceof Error && error.name === 'QualityExecutionFailure')) throw error;
              throw new QualityExecutionFailure('provider');
            });
            context.signal.throwIfAborted();
            send({ type: 'response', body: response.body });
          } else if (message.type === 'result') {
            if (resultSeen || message.manifestHash !== input.binding.toolManifestHash) {
              throw new QualityExecutionFailure('state', 'executor_integrity_changed');
            }
            resultSeen = true;
            output = typeof message.output === 'string' ? message.output : null;
          } else if (!['event', 'isolation'].includes(message.type)) throw new QualityExecutionFailure('infra');
        }
        const code = await close;
        if (code !== 0 || !resultSeen) throw new Error(`quality_application_worker_failed:${code}:${stderr.slice(0, 1200)}:${stderr.slice(-500)}`);
        return { output };
      } finally {
        context.signal.removeEventListener('abort', abort);
        lines.close();
        child.stdin.end();
        try {
          await terminate();
          writeFileSync(join(trial, 'cleanup.json'), '{"processGroupGone":true}\n', { mode: 0o600 });
        } catch {
          writeFileSync(join(trial, 'cleanup.json'), '{"processGroupGone":false}\n', { mode: 0o600 });
          throw new QualityExecutionFailure('infra', 'executor_cleanup_unconfirmed');
        }
      }
    }
  };
}
