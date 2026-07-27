import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemBackend, LocalShellBackend } from 'deepagents';
import type { GlobResult, GrepResult } from 'deepagents';
import { afterEach, describe, expect, it, vi } from 'vitest';

type GlobBackend = {
  glob: (pattern: string, path?: string) => Promise<GlobResult>;
};

const cleanupRoots: string[] = [];

afterEach(async () => {
  const roots = cleanupRoots.splice(0);
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('Deep Agents filesystem symlink conformance', () => {
  it.each([
    {
      name: 'FilesystemBackend',
      create: (root: string): GlobBackend => new FilesystemBackend({ rootDir: root, virtualMode: true }),
      searchPath: (_root: string): string => '/'
    },
    {
      name: 'LocalShellBackend',
      create: (root: string): GlobBackend => new LocalShellBackend({ rootDir: root }),
      searchPath: (root: string): string => root
    }
  ])('$name glob does not follow Windows junctions', async ({ create, searchPath }) => {
    const fixture = await createJunctionFixture();
    const result = await create(fixture.root).glob('**/*', searchPath(fixture.root));
    const paths = requireGlobPaths(result);

    expect(paths.some((path) => path.endsWith('normal.txt'))).toBe(true);
    expect(paths.filter((path) => path.endsWith('inner.txt'))).toHaveLength(1);
    expect(paths.some((path) => /sub[\\/]loop[\\/]/u.test(path))).toBe(false);
    expect(paths.some((path) => /outside-link[\\/]secret\.txt$/u.test(path))).toBe(false);
  });

  it('keeps FilesystemBackend grep fallback inside its root', async () => {
    const fixture = await createJunctionFixture();
    const backend = new FilesystemBackend({ rootDir: fixture.root, virtualMode: true });
    const fallbackTarget = backend as unknown as {
      ripgrepSearch: (...args: unknown[]) => Promise<null>;
    };
    const ripgrepSpy = vi.spyOn(fallbackTarget, 'ripgrepSearch').mockResolvedValue(null);

    const result = await backend.grep('OUTSIDE_MARKER', '/');

    expect(ripgrepSpy).toHaveBeenCalledTimes(1);
    expect(requireGrepMatches(result)).toEqual([
      {
        path: '/normal.txt',
        line: 1,
        text: 'OUTSIDE_MARKER'
      }
    ]);
  });
});

async function createJunctionFixture(): Promise<{ root: string }> {
  const container = await mkdtemp(join(tmpdir(), 'roc-deepagents-junction-'));
  cleanupRoots.push(container);
  const root = join(container, 'root');
  const sub = join(root, 'sub');
  const outside = join(container, 'outside');
  await mkdir(sub, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'normal.txt'), 'OUTSIDE_MARKER', 'utf8');
  await writeFile(join(sub, 'inner.txt'), 'inner', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_MARKER', 'utf8');
  await symlink(sub, join(sub, 'loop'), 'junction');
  await symlink(outside, join(root, 'outside-link'), 'junction');
  return { root };
}

function requireGlobPaths(result: GlobResult): string[] {
  if (result.error !== undefined) {
    throw new Error(`deepagents_glob_failed:${result.error}`);
  }
  if (result.files === undefined) {
    throw new Error('deepagents_glob_files_missing');
  }
  return result.files.map((file) => file.path);
}

function requireGrepMatches(result: GrepResult): NonNullable<GrepResult['matches']> {
  if (result.error !== undefined) {
    throw new Error(`deepagents_grep_failed:${result.error}`);
  }
  if (result.matches === undefined) {
    throw new Error('deepagents_grep_matches_missing');
  }
  return result.matches;
}
