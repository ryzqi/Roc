import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

  constructor(logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
    this.appLogPath = join(logsDir, 'app.jsonl');
    writeFileSync(this.appLogPath, '', { flag: 'a', encoding: 'utf8' });
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
    const timestamp = new Date().toISOString();
    const event = {
      level,
      pluginId,
      message,
      metadata,
      createdAt: timestamp,
      timestamp
    };
    appendFileSync(this.appLogPath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
