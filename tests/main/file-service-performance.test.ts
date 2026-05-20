import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let workspaceRoot: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-file-perf-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  services = createAppServices(root);
  services.appService.initialize();
  services.workspaceService.selectWorkspace(workspaceRoot);
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('FileService performance guardrails', () => {
  it('truncates text previews without returning the full file', () => {
    writeFileSync(join(workspaceRoot, 'large.txt'), 'a'.repeat(1024 * 1024), 'utf8');

    const preview = services.fileService.readPreview({ relativePath: 'large.txt', maxBytes: 128 });

    expect(preview).toMatchObject({
      relativePath: 'large.txt',
      kind: 'text',
      content: 'a'.repeat(128),
      truncated: true,
      sizeBytes: 1024 * 1024
    });
  });

  it('does not inline large image previews into IPC payloads', () => {
    writeFileSync(join(workspaceRoot, 'large.png'), Buffer.alloc(1024 * 1024, 1));

    const preview = services.fileService.readPreview({ relativePath: 'large.png', maxBytes: 128 });

    expect(preview).toMatchObject({
      relativePath: 'large.png',
      kind: 'binary',
      content: '',
      truncated: true,
      sizeBytes: 1024 * 1024,
      mediaType: 'image/png'
    });
  });

  it('truncates workspace search when the visited file guardrail is reached', () => {
    for (let index = 0; index < 2100; index += 1) {
      writeFileSync(join(workspaceRoot, `file-${String(index).padStart(4, '0')}.txt`), 'no match\n', 'utf8');
    }

    const search = services.fileService.search({ query: 'not-present', maxResults: 100 });

    expect(search.matches).toEqual([]);
    expect(search.truncated).toBe(true);
  });
});
