import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { buildRProcess } from '../../../scripts/research/build-r-process';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('research r-process build', () => {
  it('compiles both slices, lipos them, and writes the lock file', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-r-process-')));
    roots.push(root);
    await mkdir(join(root, 'resources/research-runtime'), { recursive: true });
    await writeFile(join(root, 'resources/research-runtime/r-process.c'), 'int roc_research_r_process(void) { return 0; }\n');
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      const output = args.includes('-output') ? args[args.indexOf('-output') + 1]
        : args.includes('-o') ? args[args.indexOf('-o') + 1]
        : args.at(-1);
      if (typeof output === 'string' && (args.includes('clang') || args.includes('lipo'))) {
        writeFileSync(output, Buffer.from(`dylib:${args.join(' ')}`));
      }
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const destination = await buildRProcess(root);
    expect(destination).toBe(join(root, 'resources/research-runtime/r-process.lock.json'));
    const lock = JSON.parse(await readFile(destination, 'utf8')) as { architectures: string[]; data: string; sha256: string };
    expect(lock.architectures).toEqual(['arm64', 'x64']);
    expect(Buffer.from(lock.data, 'base64').toString()).toContain('lipo');
    expect(spawnMock.mock.calls.map((call) => [call[0], (call[1] ?? [])[0]])).toEqual([
      ['/usr/bin/xcrun', 'clang'],
      ['/usr/bin/xcrun', 'clang'],
      ['/usr/bin/xcrun', 'lipo'],
      ['/usr/bin/codesign', '--force']
    ]);
  });
});
