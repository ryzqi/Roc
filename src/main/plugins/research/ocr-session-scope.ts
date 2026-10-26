export type DisposableOcrSession = { release(): Promise<void> };
export type OcrSessionRegistrar = (session: DisposableOcrSession) => void;

export class OcrSessionCleanupError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, 'research_ocr_session_release_failed');
    this.name = 'OcrSessionCleanupError';
  }
}

/** Owns every ONNX session created during one document parse. */
export async function withOcrSessionScope<T>(
  operation: (register: OcrSessionRegistrar) => Promise<T>
): Promise<T> {
  const sessions: DisposableOcrSession[] = [];
  const registered = new Set<DisposableOcrSession>();
  let operationFailed = false;
  let operationError: unknown;

  try {
    return await operation((session) => {
      if (registered.has(session)) return;
      registered.add(session);
      sessions.push(session);
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    const releaseErrors: unknown[] = [];
    for (const session of sessions) {
      try {
        await session.release();
      } catch (error) {
        releaseErrors.push(error);
      }
    }

    if (releaseErrors.length > 0) {
      const cleanupError = new OcrSessionCleanupError(releaseErrors);
      if (operationFailed) throwWithCleanupFailure(operationError, cleanupError, releaseErrors);
      throw cleanupError;
    }
  }
}

function throwWithCleanupFailure(operationError: unknown, cleanupError: unknown, releaseErrors: unknown[]): never {
  if (operationError instanceof Error) {
    const errorWithCleanup = operationError as Error & { cleanupErrors?: unknown[] };
    const previousErrors = errorWithCleanup.cleanupErrors ?? [];
    try {
      Object.defineProperty(operationError, 'cleanupErrors', {
        value: [...previousErrors, ...releaseErrors],
        enumerable: true,
        configurable: true
      });
    } catch {
      throw cleanupAggregate(operationError, cleanupError, releaseErrors);
    }
    throw operationError;
  }

  throw cleanupAggregate(operationError, cleanupError, releaseErrors);
}

function cleanupAggregate(operationError: unknown, cleanupError: unknown, releaseErrors: unknown[]): AggregateError {
  const aggregate = new AggregateError(
    [operationError, cleanupError],
    'research_ocr_session_release_failed_after_parse_error',
    { cause: operationError }
  );
  aggregate.name = 'OcrSessionCleanupAfterParseError';
  const code = errorCode(operationError);
  if (code !== null) Object.defineProperty(aggregate, 'code', { value: code, enumerable: true });
  attachCleanupErrors(aggregate, releaseErrors);
  return aggregate;
}

/** Produces bounded, stack-free summaries that survive the research worker boundary. */
export function summarizeOcrCleanupErrors(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  if (error instanceof OcrSessionCleanupError) return error.errors.flatMap(summarizeError).slice(0, 20);
  const cleanupErrors = (error as Error & { cleanupErrors?: unknown[] }).cleanupErrors;
  if (!Array.isArray(cleanupErrors)) return [];
  return cleanupErrors.flatMap(summarizeError).slice(0, 20);
}

/** Summarizes operation failures that arrive after the job's timeout or cancellation. */
export function summarizeOcrOperationErrors(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  const operationErrors = (error as Error & { operationErrors?: unknown[] }).operationErrors;
  if (!Array.isArray(operationErrors)) return [];
  return operationErrors.flatMap(summarizeError).slice(0, 20);
}

function attachCleanupErrors(error: Error, cleanupErrors: unknown[]): void {
  Object.defineProperty(error, 'cleanupErrors', { value: cleanupErrors, enumerable: true, configurable: true });
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  return error.code;
}

function summarizeError(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(summarizeError);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return [message.slice(0, 1000)];
}
