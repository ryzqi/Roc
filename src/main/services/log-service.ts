import { createReadStream, createWriteStream, existsSync, statSync, writeFileSync, type WriteStream } from 'node:fs';
import { readdir, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { RocPaths } from './paths';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogEventError = {
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
  /**
   * 兼容旧日志调用。新日志调用应使用 metadata。
   */
  data?: unknown;
};

export type LogEventContext = Omit<Partial<LogEvent>, 'level' | 'message' | 'error'>;

export type LogRotationConfig = {
  maxFileSizeMb: number;
  maxFiles: number;
  compress: boolean;
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

export class LogService {
  private readonly appLogPath: string;
  private readonly rotationConfig: LogRotationConfig;
  private writeStream: WriteStream | null = null;
  private writeQueue: string[] = [];
  private flushPromise: Promise<void> | null = null;
  private flushScheduled = false;
  private closed = false;
  private currentSizeBytes = 0;
  private readonly maxQueueSize = 1000;
  private readonly batchSize = 100;

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
    if (this.writeStream === null) {
      this.openWriteStream();
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
    this.writeQueue.push(`${JSON.stringify({ ...event, createdAt: timestamp, timestamp })}\n`);
    if (this.writeQueue.length > this.maxQueueSize) {
      const droppedCount = this.writeQueue.length - this.maxQueueSize;
      this.writeQueue = this.writeQueue.slice(-this.maxQueueSize);
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
      ...context,
      level: 'error',
      message,
      error: {
        code: 'error',
        message: error.message,
        stack: error.stack
      }
    });
  }

  fatal(message: string, error: Error, context: LogEventContext = {}): void {
    this.append({
      ...context,
      level: 'fatal',
      message,
      error: {
        code: 'fatal',
        message: error.message,
        stack: error.stack
      }
    });
  }

  async flush(): Promise<void> {
    if (this.flushPromise !== null) {
      try {
        await this.flushPromise;
      } catch (error) {
        this.reportWriteFailure(error);
      }
      return;
    }
    if (this.writeStream === null || this.writeQueue.length === 0) {
      return;
    }

    this.flushPromise = this.flushQueued();
    try {
      await this.flushPromise;
    } catch (error) {
      this.reportWriteFailure(error);
    } finally {
      this.flushPromise = null;
    }
  }

  async checkAndRotate(): Promise<void> {
    await this.flush();
    if (this.shouldRotate()) {
      await this.rotateCurrentFile();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    if (this.writeStream !== null) {
      const stream = this.writeStream;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
      this.writeStream = null;
    }
  }

  private openWriteStream(): void {
    this.writeStream = createWriteStream(this.appLogPath, { flags: 'a', encoding: 'utf8' });
    this.writeStream.on('error', (error) => {
      this.reportWriteFailure(error);
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.writeStream === null) {
      return;
    }
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flushQueued(): Promise<void> {
    if (this.writeStream === null) {
      return;
    }
    while (this.writeQueue.length > 0) {
      const batch = this.writeQueue.splice(0, this.batchSize);
      for (const line of batch) {
        await new Promise<void>((resolve, reject) => {
          this.writeStream!.write(line, (error) => {
            if (error !== null && error !== undefined) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        this.currentSizeBytes += Buffer.byteLength(line, 'utf8');
        if (this.shouldRotate()) {
          await this.rotateCurrentFile();
        }
      }
    }
  }

  private shouldRotate(): boolean {
    return this.currentSizeBytes >= this.rotationConfig.maxFileSizeMb * 1024 * 1024;
  }

  private async rotateCurrentFile(): Promise<void> {
    if (this.writeStream === null) {
      return;
    }

    const stream = this.writeStream;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
    this.writeStream = null;

    const archivePath = this.createArchivePath();
    await rename(this.appLogPath, archivePath);
    if (this.rotationConfig.compress) {
      await this.compressFile(archivePath);
    }
    writeFileSync(this.appLogPath, '', 'utf8');
    this.currentSizeBytes = 0;
    this.openWriteStream();
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
