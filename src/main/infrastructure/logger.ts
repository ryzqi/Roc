import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertPluginId } from './database-pool';
import { PinoJsonlBackend, type PinoLogLevel } from './pino-backend';

type PluginLogLevel = Extract<PinoLogLevel, 'info' | 'warn' | 'error'>;

type PluginLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

export class InfrastructureLogger {
  private readonly backend: PinoJsonlBackend;
  private closed = false;

  constructor(logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
    const appLogPath = join(logsDir, 'app.jsonl');
    writeFileSync(appLogPath, '', { flag: 'a', encoding: 'utf8' });
    this.backend = new PinoJsonlBackend(appLogPath);
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.backend.close();
  }

  private append(pluginId: string, level: PluginLogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (this.closed) {
      console.warn('[InfrastructureLogger] Attempted to log after close:', message);
      return;
    }

    const timestamp = new Date().toISOString();
    this.backend.write(
      level,
      {
        pluginId,
        metadata,
        createdAt: timestamp,
        timestamp
      },
      message
    );
  }
}
