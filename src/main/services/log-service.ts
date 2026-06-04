import { createWriteStream, existsSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { RocPaths } from './paths';

export type LogEvent = {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
};

export class LogService {
  private readonly appLogPath: string;
  private writeStream: WriteStream | null = null;
  private writeQueue: string[] = [];
  private flushPromise: Promise<void> | null = null;
  private flushScheduled = false;
  private closed = false;
  private readonly maxQueueSize = 1000;
  private readonly batchSize = 100;

  constructor(paths: RocPaths) {
    this.appLogPath = join(paths.logsDir, 'app.jsonl');
  }

  initialize(): void {
    if (!existsSync(this.appLogPath)) {
      writeFileSync(this.appLogPath, '', 'utf8');
    }
    if (this.writeStream === null) {
      this.writeStream = createWriteStream(this.appLogPath, { flags: 'a', encoding: 'utf8' });
      this.writeStream.on('error', (error) => {
        this.reportWriteFailure(error);
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

    this.writeQueue.push(`${JSON.stringify({ ...event, createdAt: new Date().toISOString() })}\n`);
    if (this.writeQueue.length > this.maxQueueSize) {
      const droppedCount = this.writeQueue.length - this.maxQueueSize;
      this.writeQueue = this.writeQueue.slice(-this.maxQueueSize);
      console.warn(`[LogService] Queue overflow, dropping ${droppedCount} logs`);
    }
    this.scheduleFlush();
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
      }
    }
  }

  private reportWriteFailure(error: unknown): void {
    console.error('[LogService] Write failed:', error);
  }
}
