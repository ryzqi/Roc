import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadReferencedFileContexts } from '../../src/main/services/deep-agent/context/referenced-files';

const fixtureFiles = [
  'src/renderer/chat/chat-composer.tsx',
  'src/renderer/chat/composer-trigger.ts',
  'docs/readme.md'
];

let workspacePath = '';

beforeAll(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'roc-referenced-files-'));
  fixtureFiles.forEach((relativePath) => {
    const absolutePath = join(workspacePath, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, 'fixture', 'utf8');
  });
  mkdirSync(join(workspacePath, 'src/renderer/chat/nested'), { recursive: true });
});

afterAll(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

describe('loadReferencedFileContexts', () => {
  it('keeps references that resolve to real workspace files', () => {
    const contexts = loadReferencedFileContexts({
      userInput: '解释一下 @src/renderer/chat/chat-composer.tsx 和 @docs/readme.md',
      workspacePath
    });

    expect(contexts).toEqual([
      { path: 'src/renderer/chat/chat-composer.tsx' },
      { path: 'docs/readme.md' }
    ]);
  });

  it('drops tokens that do not exist in the workspace', () => {
    const contexts = loadReferencedFileContexts({
      userInput: '看看 @src/does-not-exist.ts',
      workspacePath
    });

    expect(contexts).toEqual([]);
  });

  it('drops directories because only files are referenceable', () => {
    const contexts = loadReferencedFileContexts({
      userInput: '看看 @src/renderer/chat/nested',
      workspacePath
    });

    expect(contexts).toEqual([]);
  });

  it('ignores @ that is not at a token start', () => {
    const contexts = loadReferencedFileContexts({
      userInput: '联系 user@example.com 或者 npm i @scope/pkg',
      workspacePath
    });

    expect(contexts).toEqual([]);
  });

  it('rejects escapes out of the workspace and absolute paths', () => {
    const contexts = loadReferencedFileContexts({
      userInput: `读 @../outside.txt 和 @/etc/hosts 和 @C:\\Windows\\win.ini`,
      workspacePath
    });

    expect(contexts).toEqual([]);
  });

  it('trims trailing punctuation before resolving', () => {
    const contexts = loadReferencedFileContexts({
      userInput: '请读 @docs/readme.md。',
      workspacePath
    });

    expect(contexts).toEqual([{ path: 'docs/readme.md' }]);
  });

  it('dedupes repeated references while preserving first-seen order', () => {
    const contexts = loadReferencedFileContexts({
      userInput: '@docs/readme.md @src/renderer/chat/composer-trigger.ts @docs/readme.md',
      workspacePath
    });

    expect(contexts).toEqual([
      { path: 'docs/readme.md' },
      { path: 'src/renderer/chat/composer-trigger.ts' }
    ]);
  });

  it('caps the number of referenced files at 20', () => {
    const manyPaths: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const relativePath = `bulk/file-${index}.md`;
      const absolutePath = join(workspacePath, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, 'fixture', 'utf8');
      manyPaths.push(`@${relativePath}`);
    }

    const contexts = loadReferencedFileContexts({
      userInput: manyPaths.join(' '),
      workspacePath
    });

    expect(contexts).toHaveLength(20);
    expect(contexts[0]).toEqual({ path: 'bulk/file-0.md' });
    expect(contexts[19]).toEqual({ path: 'bulk/file-19.md' });
  });

  it('returns nothing when no workspace is open', () => {
    const contexts = loadReferencedFileContexts({
      userInput: '解释一下 @docs/readme.md',
      workspacePath: null
    });

    expect(contexts).toEqual([]);
  });
});
