import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RocPathsSnapshot } from '../../shared/types';

export class RocPaths {
  readonly root: string;
  readonly configDir: string;
  readonly databasePath: string;
  readonly memoryDir: string;
  readonly logsDir: string;
  readonly diagnosticsDir: string;
  readonly skillsDir: string;
  readonly artifactsDir: string;
  readonly indexesDir: string;
  readonly tasksDir: string;
  readonly terminalDir: string;
  readonly rtkDir: string;
  readonly toolsDir: string;
  readonly secretsDir: string;

  constructor(root = join(homedir(), '.roc')) {
    this.root = root;
    this.configDir = join(root, 'config');
    this.databasePath = join(root, 'roc.sqlite');
    this.memoryDir = join(root, 'memory');
    this.logsDir = join(root, 'logs');
    this.diagnosticsDir = join(root, 'diagnostics');
    this.skillsDir = join(root, 'skills');
    this.artifactsDir = join(root, 'tasks', 'artifacts');
    this.indexesDir = join(root, 'indexes');
    this.tasksDir = join(root, 'tasks');
    this.terminalDir = join(root, 'terminal');
    this.rtkDir = join(root, 'rtk');
    this.toolsDir = join(root, 'tools');
    this.secretsDir = join(root, 'secrets');
  }

  ensureTree(): void {
    const dirs = [
      this.root,
      this.configDir,
      this.skillsDir,
      join(this.indexesDir, 'fts'),
      join(this.indexesDir, 'vector_store'),
      this.artifactsDir,
      join(this.tasksDir, 'async-subagents'),
      join(this.tasksDir, 'diagnostics'),
      join(this.tasksDir, 'recovery'),
      join(this.terminalDir, 'sessions'),
      join(this.terminalDir, 'logs'),
      join(this.rtkDir, 'tee'),
      join(this.rtkDir, 'filters'),
      join(this.rtkDir, 'audit'),
      this.logsDir,
      this.diagnosticsDir,
      this.toolsDir,
      this.secretsDir
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }
  }

  snapshot(): RocPathsSnapshot {
    return {
      root: this.root,
      configDir: this.configDir,
      databasePath: this.databasePath,
      memoryDir: this.memoryDir,
      logsDir: this.logsDir,
      diagnosticsDir: this.diagnosticsDir,
      skillsDir: this.skillsDir,
      artifactsDir: this.artifactsDir
    };
  }
}

export function buildWorkspaceHash(workspacePath: string | null): string | null {
  if (workspacePath === null) {
    return null;
  }
  const normalized = resolve(workspacePath).toLowerCase();
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}
