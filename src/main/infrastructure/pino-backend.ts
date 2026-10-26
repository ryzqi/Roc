import pino from 'pino';
import type { DestinationStream } from 'pino';

export type PinoLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type PinoJsonlBackendOptions = {
  maxBufferedBytes?: number;
  onWrite?: (line: string) => void;
  destination?: SonicDestination;
};

type SonicDestination = ReturnType<typeof pino.destination> & {
  destroyed: boolean;
  fd: number;
};

const defaultMaxBufferedBytes = 8 * 1024 * 1024;
const defaultMinLength = 4096;
const sensitiveFieldNames = [
  'apiKey',
  'api_key',
  'api-key',
  'accessToken',
  'access_token',
  'access-token',
  'authorization',
  'clientSecret',
  'client_secret',
  'client-secret',
  'credential',
  'password',
  'privateKey',
  'private_key',
  'private-key',
  'refreshToken',
  'secret',
  'token'
];
const redactPaths = [...new Set(sensitiveFieldNames.flatMap((field) => [field, `*.${field}`, `**.${field}`]))];
const normalizedSensitiveFieldNames = new Set(sensitiveFieldNames.map(normalizeFieldName));

function normalizeFieldName(field: string): string {
  return field.replace(/[-_]/gu, '').toLowerCase();
}

function isSensitiveField(field: string): boolean {
  return normalizedSensitiveFieldNames.has(normalizeFieldName(field));
}

function redactSensitiveFields(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) result.push(redactSensitiveFields(entry, seen));
    return result;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value) || value instanceof Error) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const result: Record<string, unknown> = Object.create(prototype);
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveField(key) ? '[REDACTED]' : redactSensitiveFields(entry, seen);
  }
  return result;
}

class CountingDestination implements DestinationStream {
  private dropCount = 0;

  constructor(
    private readonly destination: SonicDestination,
    private readonly onWrite: ((line: string) => void) | undefined,
    private readonly onDrop: (bytes: number) => void
  ) {
    destination.on('drop', (line: string | Buffer) => {
      this.dropCount += 1;
      this.onDrop(typeof line === 'string' ? Buffer.byteLength(line, 'utf8') : line.byteLength);
    });
  }

  write(line: string): void {
    const dropsBeforeWrite = this.dropCount;
    this.destination.write(line);
    if (this.dropCount === dropsBeforeWrite) this.onWrite?.(line);
  }

  flush(callback?: (error?: Error) => void): void {
    this.destination.flush(callback);
  }
}

export class PinoJsonlBackend {
  private readonly destination: SonicDestination;
  private readonly logger: ReturnType<typeof pino>;
  private readyCount = 0;
  private readonly readyWaiters = new Set<{
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private failed = false;
  private closed = false;

  constructor(
    path: string,
    options: PinoJsonlBackendOptions = {}
  ) {
    const maxBufferedBytes = options.maxBufferedBytes ?? defaultMaxBufferedBytes;
    if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
      throw new Error('pino_buffer_limit_invalid');
    }

    this.destination = options.destination ?? (pino.destination({
      dest: path,
      maxLength: maxBufferedBytes,
      minLength: defaultMinLength,
      mode: 0o600,
      sync: false
    }) as SonicDestination);
    this.destination.on('ready', () => {
      this.readyCount += 1;
      for (const waiter of this.readyWaiters) {
        if (this.readyCount >= waiter.count) {
          this.readyWaiters.delete(waiter);
          waiter.resolve();
        }
      }
    });
    this.destination.on('error', (error: Error) => {
      this.failed = true;
      this.reportDestinationError(error);
      for (const waiter of this.readyWaiters) {
        this.readyWaiters.delete(waiter);
        waiter.reject(error);
      }
    });

    const stream = new CountingDestination(
      this.destination,
      options.onWrite,
      (bytes) => console.warn(`[PinoJsonlBackend] SonicBoom dropped a log record (${bytes} bytes)`)
    );
    this.logger = pino(
      {
        base: null,
        level: 'trace',
        messageKey: 'message',
        redact: {
          censor: '[REDACTED]',
          paths: redactPaths
        },
        timestamp: false,
        formatters: {
          level: (label) => ({ level: label })
        }
      },
      stream
    );
  }

  write(level: PinoLogLevel, fields: Record<string, unknown>, message: string): void {
    if (this.closed) {
      console.warn('[PinoJsonlBackend] Attempted to log after close:', message);
      return;
    }
    if (this.failed) return;

    try {
      this.logger[level](redactSensitiveFields(fields) as Record<string, unknown>, message);
    } catch (error) {
      this.reportDestinationError(error);
    }
  }

  async flush(): Promise<void> {
    if (this.failed || this.destination.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      try {
        this.logger.flush((error) => {
          if (error != null) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async reopen(): Promise<void> {
    if (this.closed) throw new Error('pino_backend_closed');
    await this.waitUntilReady();
    const ready = this.waitForReadyCount(this.readyCount + 1);
    try {
      this.destination.reopen();
    } catch (error) {
      this.reportDestinationError(error);
      throw error;
    }
    await ready;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.flush();
    } catch (error) {
      this.reportDestinationError(error);
    }

    if (this.destination.destroyed || this.destination.fd < 0) return;
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      this.destination.once('close', finish);
      this.destination.once('error', finish);
      try {
        this.destination.end();
      } catch (error) {
        this.reportDestinationError(error);
        resolve();
      }
    });
  }

  private async waitUntilReady(): Promise<void> {
    if (this.readyCount > 0) return;
    await this.waitForReadyCount(1);
  }

  private waitForReadyCount(count: number): Promise<void> {
    if (this.readyCount >= count) return Promise.resolve();
    if (this.failed) return Promise.reject(new Error('pino_destination_unavailable'));
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.add({ count, resolve, reject });
    });
  }

  private reportDestinationError(error: unknown): void {
    console.error('[PinoJsonlBackend] Destination error:', error);
  }
}
