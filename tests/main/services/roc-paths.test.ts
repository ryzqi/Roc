import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RocPaths } from '../../../src/main/services/paths';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-paths-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('RocPaths user data tree', () => {
  it('creates exactly the approved install directories and no files', () => {
    const paths = new RocPaths(root);

    paths.ensureTree();

    expect(listRelativeDirectories(root)).toEqual([
      'config',
      'diagnostics',
      'indexes',
      'indexes/fts',
      'indexes/vector_store',
      'logs',
      'rtk',
      'rtk/audit',
      'rtk/filters',
      'rtk/tee',
      'secrets',
      'skills',
      'tasks',
      'tasks/artifacts',
      'tasks/async-subagents',
      'tasks/diagnostics',
      'tasks/recovery',
      'terminal',
      'terminal/logs',
      'terminal/sessions',
      'tools'
    ]);
    expect(listRelativeFiles(root)).toEqual([]);
    expect(existsSync(join(root, 'memory'))).toBe(false);
    expect(existsSync(join(root, 'plugin-data'))).toBe(false);
    expect(existsSync(join(root, 'hooks.json'))).toBe(false);
  });
});

function listRelativeDirectories(base: string): string[] {
  return listRelativeEntries(base, 'directory');
}

function listRelativeFiles(base: string): string[] {
  return listRelativeEntries(base, 'file');
}

function listRelativeEntries(base: string, kind: 'directory' | 'file'): string[] {
  const entries: string[] = [];
  collectRelativeEntries(base, base, kind, entries);
  return entries.sort();
}

function collectRelativeEntries(base: string, current: string, kind: 'directory' | 'file', entries: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (kind === 'directory') {
        entries.push(toRelativePath(base, absolutePath));
      }
      collectRelativeEntries(base, absolutePath, kind, entries);
      continue;
    }
    if (kind === 'file' && statSync(absolutePath).isFile()) {
      entries.push(toRelativePath(base, absolutePath));
    }
  }
}

function toRelativePath(base: string, absolutePath: string): string {
  return relative(base, absolutePath).replaceAll('\\', '/');
}
