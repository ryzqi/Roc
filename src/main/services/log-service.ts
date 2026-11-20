import { createReadStream, createWriteStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { readdir, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { RocPaths } from './paths';
import { PinoJsonlBackend, type PinoLogLevel } from '../infrastructure/pino-backend';

type LogLevel = PinoLogLevel;

type LogEventError = {
  code: string;
  message: string;
  stack?: string;
  category?: string;
};

export type LogEvent = {
  level: LogLevel;
  message: string;
  service?: string;
  component?: string;
  traceId?: string;
  runId?: string;
  threadId?: string;
  error?: LogEventError;
  metadata?: Record<string, unknown>;
  durationMs?: number;
  memoryMb?: number;
};

export type LogEventContext = Omit<Partial<LogEvent>, 'level' | 'message'>;

export type LogRotationConfig = {
  maxFileSizeMb: number;
  maxFiles: number;
  compress: boolean;
};

type QueuedLogEvent = {
  event: LogEvent & { createdAt: string; timestamp: string };
  bytes: number;
};

type LogArchiveFile = {
  fileName: string;
  sequence: number;
  timestamp: string;
};

const defaultRotationConfig: LogRotationConfig = {
  maxFileSizeMb: 50,
  maxFiles: 10,
  compress: false
};
const maxQueueSize = 1000;
const maxQueueBytes = 4 * 1024 * 1024;
const batchSize = 100;

function estimateQueuedBytes(value: unknown, limit: number): number {
  let bytes = 64;
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): void => {
    if (bytes > limit) return;
    if (typeof entry === 'string') {
      bytes += entry.length * 2 + 16;
      return;
    }
    if (entry === null || typeof entry !== 'object') {
      bytes += 16;
      return;
    }
    if (seen.has(entry)) return;
    seen.add(entry);
    if (Array.isArray(entry)) {
      bytes += 32;
      for (const item of entry) {
        bytes += 8;
        visit(item);
        if (bytes > limit) return;
      }
      return;
    }
    bytes += 32;
    for (const key in entry) {
      if (!Object.hasOwn(entry, key)) continue;
      bytes += key.length * 2 + 16;
      visit((entry as Record<string, unknown>)[key]);
      if (bytes > limit) return;
    }
  };
  visit(value);
  return bytes;
}

export class LogService {
  private readonly appLogPath: string;
  private readonly rotationConfig: LogRotationConfig;
  private backend: PinoJsonlBackend | null = null;
  private writeQueue: QueuedLogEvent[] = [];
  private writeQueueBytes = 0;
  private flushPromise: Promise<void> | null = null;
  private rotationPromise: Promise<void> | null = null;
  private flushScheduled = false;
  private closed = false;
  private currentSizeBytes = 0;

  constructor(paths: RocPaths, rotationConfig: Partial<LogRotationConfig> = {}) {
    this.appLogPath = join(paths.logsDir, 'app.jsonl');
    this.rotationConfig = {
      ...defaultRotationConfig,
      ...rotationConfig
    };
  }

  initialize(): void {
    if (!existsSync(this.appLogPath)) {
      writeFileSync(this.appLogPath, '', 'utf8');
    }
    this.currentSizeBytes = statSync(this.appLogPath).size;
    if (this.backend === null && !this.closed) {
      this.backend = new PinoJsonlBackend(this.appLogPath, {
        onWrite: (line) => {
          this.currentSizeBytes += Buffer.byteLength(line, 'utf8');
        }
      });
    }
    if (this.writeQueue.length > 0) {
      this.scheduleFlush();
    }
  }

  append(event: LogEvent): void {
    if (this.closed) {
      console.warn('[LogService] Attempted to log after close:', event.message);
      return;
    }

    const timestamp = new Date().toISOString();
    const queuedEvent = { ...event, createdAt: timestamp, timestamp };
    const bytes = estimateQueuedBytes(queuedEvent, maxQueueBytes);
    if (bytes > maxQueueBytes) {
      console.warn(`[LogService] Queue overflow, dropping 1 logs (record exceeds ${maxQueueBytes} bytes)`);
      return;
    }

    this.writeQueue.push({ event: queuedEvent, bytes });
    this.writeQueueBytes += bytes;
    let droppedCount = 0;
    while (this.writeQueue.length > maxQueueSize || this.writeQueueBytes > maxQueueBytes) {
      const dropped = this.writeQueue.shift();
      if (dropped !== undefined) {
        this.writeQueueBytes -= dropped.bytes;
        droppedCount += 1;
      }
    }
    if (droppedCount > 0) {
      console.warn(`[LogService] Queue overflow, dropping ${droppedCount} logs`);
    }
    this.scheduleFlush();
  }

  debug(message: string, context: LogEventContext = {}): void {
    this.append({ ...context, level: 'debug', message });
  }

  info(message: string, context: LogEventContext = {}): void {
    this.append({ ...context, level: 'info', message });
  }

  warn(message: string, context: LogEventContext = {}): void {
    this.append({ ...context, level: 'warn', message });
  }

  error(message: string, error: Error, context: LogEventContext = {}): void {
    this.append({
      level: 'error',
      message,
      error: {
        code: 'error',
        message: error.message,
        stack: error.stack
      },
      ...context
    });
  }

  fatal(message: string, error: Error, context: LogEventContext = {}): void {
    this.append({
      level: 'fatal',
      message,
      error: {
        code: 'fatal',
        message: error.message,
        stack: error.stack
      },
      ...context
    });
  }

  async flush(): Promise<void> {
    if (this.flushPromise !== null) {
      await this.flushPromise;
      if (this.writeQueue.length > 0) await this.flush();
      return;
    }
    if (this.backend === null) return;

    this.flushPromise = this.flushQueued();
    try {
      await this.flushPromise;
    } catch (error) {
      this.reportWriteFailure(error);
    } finally {
      this.flushPromise = null;
    }
    if (this.writeQueue.length > 0 && !this.closed) await this.flush();
  }

  async checkAndRotate(): Promise<void> {
    await this.flush();
    if (this.shouldRotate()) {
      await this.rotateCurrentFile();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    await this.backend?.close();
    this.backend = null;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.backend === null) {
      return;
    }
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flushQueued(): Promise<void> {
    const backend = this.backend;
    if (backend === null) return;
    let batchCount = 0;
    while (this.writeQueue.length > 0) {
      if (this.rotationPromise !== null) {
        await this.rotationPromise;
      }
      const queued = this.writeQueue.shift();
      if (queued === undefined) continue;
      this.writeQueueBytes -= queued.bytes;
      const { level, message, ...fields } = queued.event;
      backend.write(level, fields, message);
      batchCount += 1;

      if (this.shouldRotate()) {
        await this.rotateCurrentFile();
        batchCount = 0;
      } else if (batchCount >= batchSize) {
        await backend.flush();
        batchCount = 0;
      }
    }
    await backend.flush();
  }

  private shouldRotate(): boolean {
    return this.currentSizeBytes >= this.rotationConfig.maxFileSizeMb * 1024 * 1024;
  }

  private async rotateCurrentFile(): Promise<void> {
    if (this.backend === null) return;
    if (this.rotationPromise !== null) {
      await this.rotationPromise;
      return;
    }

    const rotation = this.performRotation();
    this.rotationPromise = rotation;
    try {
      await rotation;
    } finally {
      if (this.rotationPromise === rotation) this.rotationPromise = null;
    }
  }

  private async performRotation(): Promise<void> {
    const backend = this.backend;
    if (backend === null) return;

    await backend.flush();
    const archivePath = this.createArchivePath();
    await rename(this.appLogPath, archivePath);
    await backend.reopen();
    this.currentSizeBytes = 0;
    if (this.rotationConfig.compress) {
      await this.compressFile(archivePath);
    }
    await this.cleanupOldLogs();
  }

  private createArchivePath(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? timestamp : `${timestamp}-${index}`;
      const archivePath = this.appLogPath.replace('.jsonl', `.${suffix}.jsonl`);
      if (!existsSync(archivePath) && !existsSync(`${archivePath}.gz`)) {
        return archivePath;
      }
    }
    throw new Error('Unable to allocate a unique log archive path.');
  }

  private async compressFile(filePath: string): Promise<void> {
    const gzipPath = `${filePath}.gz`;
    const source = createReadStream(filePath);
    const destination = createWriteStream(gzipPath);
    const gzip = createGzip();
    await pipeline(source, gzip, destination);
    await unlink(filePath);
  }

  private async cleanupOldLogs(): Promise<void> {
    const files = await readdir(dirname(this.appLogPath));
    const archiveFiles = files
      .map((fileName) => this.parseArchiveFile(fileName))
      .filter((archiveFile): archiveFile is LogArchiveFile => archiveFile !== null)
      .sort((left, right) => {
        const timestampOrder = right.timestamp.localeCompare(left.timestamp);
        if (timestampOrder !== 0) {
          return timestampOrder;
        }
        return right.sequence - left.sequence;
      });

    for (const archiveFile of archiveFiles.slice(this.rotationConfig.maxFiles)) {
      await unlink(join(dirname(this.appLogPath), archiveFile.fileName));
    }
  }

  private parseArchiveFile(fileName: string): LogArchiveFile | null {
    const match = /^app\.(.+Z)(?:-(\d+))?\.jsonl(?:\.gz)?$/.exec(fileName);
    if (match === null) {
      return null;
    }
    return {
      fileName,
      timestamp: match[1],
      sequence: match[2] === undefined ? 0 : Number(match[2])
    };
  }

  private reportWriteFailure(error: unknown): void {
    console.error('[LogService] Write failed:', error);
  }
}
