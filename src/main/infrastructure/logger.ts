import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

import { assertPluginId } from './database-pool';

type PluginLogLevel = 'info' | 'warn' | 'error';

type PluginLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

export class InfrastructureLogger {
  private readonly appLogPath: string;
  private readonly writeStream: WriteStream;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
    this.appLogPath = join(logsDir, 'app.jsonl');
    writeFileSync(this.appLogPath, '', { flag: 'a', encoding: 'utf8' });
    this.writeStream = createWriteStream(this.appLogPath, { flags: 'a', encoding: 'utf8' });
    this.writeStream.on('error', (error) => {
      this.reportWriteFailure(error);
    });
  }

  createPluginLogger(pluginId: string): PluginLogger {
    assertPluginId(pluginId);
    return {
      info: (message, metadata) => {
        this.append(pluginId, 'info', message, metadata);
      },
      warn: (message, metadata) => {
        this.append(pluginId, 'warn', message, metadata);
      },
      error: (message, metadata) => {
        this.append(pluginId, 'error', message, metadata);
      }
    };
  }

  private append(pluginId: string, level: PluginLogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (this.closed) {
      console.warn('[InfrastructureLogger] Attempted to log after close:', message);
      return;
    }

    const timestamp = new Date().toISOString();
    const event = {
      level,
      pluginId,
      message,
      metadata,
      createdAt: timestamp,
      timestamp
    };
    const line = `${JSON.stringify(event)}\n`;
    this.writeChain = this.writeChain
      .then(() => this.writeLine(line))
      .catch((error: unknown) => {
        this.reportWriteFailure(error);
      });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.writeChain;
    await new Promise<void>((resolve) => {
      this.writeStream.end(() => resolve());
    });
  }

  private async writeLine(line: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.writeStream.write(line, (error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private reportWriteFailure(error: unknown): void {
    console.error('[InfrastructureLogger] Write failed:', error);
  }
}
