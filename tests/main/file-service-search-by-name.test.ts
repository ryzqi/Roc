import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FileService } from '../../src/main/services/file-service';
import type { WorkspaceService } from '../../src/main/services/workspace-service';

const fixtureFiles = [
  'src/renderer/chat/chat-composer.tsx',
  'src/renderer/chat/composer-trigger.ts',
  'src/main/services/file-service.ts',
  'chat-composer.tsx',
  'node_modules/ignored/chat-composer.tsx',
  'docs/readme.md'
];

let workspacePath = '';
let fileService: FileService;

function createFileService(root: string): FileService {
  const workspaceService = {
    requireWorkspace: () => ({
      id: 'workspace_1',
      path: root,
      displayName: 'fixture',
      lastOpenedAt: '2026-08-23T00:00:00.000Z',
      trustState: 'trusted' as const
    })
  } as unknown as WorkspaceService;
  return new FileService({} as never, {} as never, workspaceService);
}

beforeAll(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'roc-name-search-'));
  fixtureFiles.forEach((relativePath) => {
    const absolutePath = join(workspacePath, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, 'fixture', 'utf8');
  });
  fileService = createFileService(workspacePath);
});

afterAll(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

describe('FileService.searchByName', () => {
  it('matches file names by case-insensitive subsequence', () => {
    const result = fileService.searchByName({ query: 'chatcomp' });

    expect(result.query).toBe('chatcomp');
    // 子序列匹配同时覆盖 basename 与整条相对路径，basename 命中排在前面。
    expect(result.matches.map((match) => match.relativePath)).toEqual([
      'chat-composer.tsx',
      'src/renderer/chat/chat-composer.tsx',
      'src/renderer/chat/composer-trigger.ts'
    ]);
  });

  it('ranks basename hits above path-only hits', () => {
    const result = fileService.searchByName({ query: 'trigger' });

    expect(result.matches[0]?.relativePath).toBe('src/renderer/chat/composer-trigger.ts');

    const pathOnly = fileService.searchByName({ query: 'services' });
    expect(pathOnly.matches.map((match) => match.relativePath)).toEqual(['src/main/services/file-service.ts']);
  });

  it('skips ignored directories such as node_modules', () => {
    const result = fileService.searchByName({ query: 'composer' });

    expect(result.matches.some((match) => match.relativePath.includes('node_modules'))).toBe(false);
  });

  it('returns the first candidates for an empty query instead of failing', () => {
    const result = fileService.searchByName({ query: '', maxResults: 3 });

    expect(result.query).toBe('');
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('reports truncation when matches exceed maxResults', () => {
    const result = fileService.searchByName({ query: 'c', maxResults: 1 });

    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('reports the file name separately from the relative path', () => {
    const result = fileService.searchByName({ query: 'readme' });

    expect(result.matches).toEqual([{ name: 'readme.md', relativePath: 'docs/readme.md' }]);
    expect(result.truncated).toBe(false);
  });
});
