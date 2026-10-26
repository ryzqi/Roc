import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ResearchProcessError } from './process-runner';

export type ResearchJobPaths = {
  root: string;
  source: string;
  output: string;
  sourceHash: string;
};

export function researchJobError(code: string): never {
  throw new ResearchProcessError(code);
}

export function requireAbsolutePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    researchJobError('research_absolute_path_required');
  }
  return value;
}

async function resolveResearchPath(path: string, strict: boolean): Promise<string> {
  const absolute = requireAbsolutePath(path);
  const segments = absolute.split('/').filter((part, index) => index === 0 || part.length > 0);
  let resolved = '/';
  for (let index = 1; index < segments.length; index += 1) {
    const next = resolved === '/' ? `/${segments[index]}` : join(resolved, segments[index]);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink() && index === segments.length - 1) {
        researchJobError('research_path_symlink');
      }
      resolved = await realpath(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || strict) {
        throw error;
      }
      return join(resolved, ...segments.slice(index));
    }
  }
  return resolved;
}

export function assertInsideProject(root: string, target: string): void {
  if (target === root) {
    researchJobError('research_path_outside_project');
  }
  const path = relative(root, target);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    researchJobError('research_path_outside_project');
  }
}

export async function hashResearchFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function prepareResearchJob(input: {
  projectRoot: string;
  sourcePath: string;
  outputDir: string;
  maxSourceBytes: number;
  sourceExtensions?: readonly string[];
  sourceExtensionError?: string;
}): Promise<ResearchJobPaths> {
  const root = await resolveResearchPath(input.projectRoot, true);
  if (!(await lstat(root)).isDirectory()) {
    researchJobError('research_project_directory_required');
  }
  const source = await resolveResearchPath(input.sourcePath, true);
  assertInsideProject(root, source);
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile()) {
    researchJobError('research_source_file_required');
  }
  if (sourceInfo.size > input.maxSourceBytes) {
    researchJobError('research_source_too_large');
  }
  if (input.sourceExtensions !== undefined) {
    const name = basename(source).toLowerCase();
    if (!input.sourceExtensions.some((extension) => name.endsWith(extension))) {
      researchJobError(input.sourceExtensionError ?? 'research_source_format_unsupported');
    }
  }
  try {
    await lstat(input.outputDir);
    researchJobError('research_output_already_exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const output = await resolveResearchPath(input.outputDir, false);
  assertInsideProject(root, output);
  if (dirname(output) === output) {
    researchJobError('research_path_outside_project');
  }
  return { root, source, output, sourceHash: await hashResearchFile(source) };
}

export async function runResearchJob<T extends object>(
  input: Parameters<typeof prepareResearchJob>[0] & {
    signal?: AbortSignal;
    timeoutMs?: number;
    awaitOperationCleanupOnAbort?: boolean;
  },
  operation: (job: ResearchJobPaths, signal: AbortSignal) => Promise<T>
): Promise<T & { sourceHash: string }> {
  if (input.signal?.aborted) {
    researchJobError('research_process_cancelled');
  }
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('research_process_timeout_required');
  }
  const job = await prepareResearchJob(input);
  await mkdir(job.output, { recursive: true, mode: 0o700 });
  const created = await lstat(job.output);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    await rm(job.output, { recursive: true, force: true });
    researchJobError('research_directory_invalid');
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  timeout.unref();
  let operationPromise: Promise<T> | undefined;
  try {
    if (input.signal?.aborted || controller.signal.aborted) {
      researchJobError('research_process_cancelled');
    }
    operationPromise = Promise.resolve(operation(job, controller.signal));
    const result = await Promise.race([
      operationPromise,
      new Promise<never>((_, reject) => {
        const fail = (): void => {
          reject(new ResearchProcessError(input.signal?.aborted ? 'research_process_cancelled' : 'research_process_timeout'));
        };
        if (controller.signal.aborted) {
          fail();
          return;
        }
        controller.signal.addEventListener('abort', fail, { once: true });
      })
    ]);
    if (await hashResearchFile(job.source) !== job.sourceHash) {
      researchJobError('research_source_changed_during_parse');
    }
    return { ...result, sourceHash: job.sourceHash };
  } catch (error) {
    let failure = error;
    if (input.awaitOperationCleanupOnAbort === true && controller.signal.aborted && operationPromise !== undefined) {
      try {
        await operationPromise;
      } catch (operationError) {
        failure = preserveAbortFailure(error, operationError);
      }
    }
    try {
      await rm(job.output, { recursive: true, force: true });
    } catch (cleanupError) {
      failure = attachResearchJobErrorDetails(failure, { outputCleanupErrors: [cleanupError] }, 'research_job_output_cleanup_failed');
    }
    throw failure;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}

function preserveAbortFailure(primaryError: unknown, operationError: unknown): unknown {
  if (operationError === primaryError) return primaryError;
  const operationCode = errorCode(operationError);
  const isAbortContinuation = operationCode === 'research_process_cancelled' || operationCode === 'research_cancelled';
  const nestedCleanupErrors = operationError instanceof Error
    ? (operationError as Error & { cleanupErrors?: unknown[] }).cleanupErrors ?? []
    : [];
  const isCleanupAggregate = operationError instanceof AggregateError && operationError.name === 'OcrSessionCleanupError';
  const isCleanupAfterParseAggregate = operationError instanceof AggregateError && operationError.name === 'OcrSessionCleanupAfterParseError';
  const cleanupErrors = isCleanupAggregate ? operationError.errors : nestedCleanupErrors;
  const parseCause = isCleanupAfterParseAggregate ? operationError.cause : undefined;
  const parseCauseCode = errorCode(parseCause);
  const isParseCauseAbort = parseCauseCode === 'research_process_cancelled' || parseCauseCode === 'research_cancelled';
  const operationErrors = isAbortContinuation || isCleanupAggregate || isParseCauseAbort
    ? []
    : isCleanupAfterParseAggregate && parseCause !== undefined
      ? [parseCause]
      : [operationError];
  if (cleanupErrors.length === 0 && operationErrors.length === 0) return primaryError;

  return attachResearchJobErrorDetails(primaryError, { cleanupErrors, operationErrors }, 'research_job_abort_cleanup_failed');
}

function attachResearchJobErrorDetails(
  primaryError: unknown,
  details: { cleanupErrors?: unknown[]; operationErrors?: unknown[]; outputCleanupErrors?: unknown[] },
  aggregateMessage: string
): unknown {
  const entries = Object.entries(details).filter((entry): entry is [keyof typeof details, unknown[]] =>
    Array.isArray(entry[1]) && entry[1].length > 0
  );
  if (entries.length === 0) return primaryError;

  if (primaryError instanceof Error) {
    try {
      for (const [key, errors] of entries) {
        const previous = (primaryError as Error & Record<string, unknown[]>)[key] ?? [];
        Object.defineProperty(primaryError, key, { value: [...previous, ...errors], enumerable: true, configurable: true });
      }
      return primaryError;
    } catch {
      // Use an aggregate only when the original failure cannot accept diagnostic fields.
    }
  }

  const secondaryErrors = entries.flatMap(([, errors]) => errors);
  const aggregate = new AggregateError(
    [primaryError, ...secondaryErrors],
    aggregateMessage,
    { cause: primaryError }
  );
  const primaryCode = errorCode(primaryError);
  if (primaryCode !== null) Object.defineProperty(aggregate, 'code', { value: primaryCode, enumerable: true });
  for (const [key, errors] of entries) {
    Object.defineProperty(aggregate, key, { value: errors, enumerable: true, configurable: true });
  }
  return aggregate;
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  return error.code;
}
