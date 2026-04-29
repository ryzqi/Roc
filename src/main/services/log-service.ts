import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RocPaths } from './paths';

export class LogService {
  private readonly appLogPath: string;

  constructor(paths: RocPaths) {
    this.appLogPath = join(paths.logsDir, 'app.jsonl');
  }

  initialize(): void {
    if (!existsSync(this.appLogPath)) {
      writeFileSync(this.appLogPath, '', 'utf8');
    }
  }

  append(event: { level: 'info' | 'warn' | 'error'; message: string; data?: unknown }): void {
    appendFileSync(
      this.appLogPath,
      `${JSON.stringify({ ...event, createdAt: new Date().toISOString() })}\n`,
      'utf8'
    );
  }
}
