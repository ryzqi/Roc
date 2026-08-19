import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '@langchain/langgraph';
import { FilesystemBackend } from 'deepagents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../../../../src/main/services/deep-agent/backend';
import {
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR,
  createRocFilesystemPermissions
} from '../../../../src/main/services/deep-agent/filesystem-tool-contract';
import { CapacityService } from '../../../../src/main/services/memory/capacity';
import { defaultSettings } from '../../../../src/main/services/config/defaults';
import { SecurityScanService } from '../../../../src/main/services/memory/security-scan';
import { RocPaths } from '../../../../src/main/services/paths';

const workspacePath = 'F:\\Code\\Roc';
const cleanupRoots: string[] = [];

type TestBackend = ReturnType<typeof createBackend>['backend'] & {
  ls: (path: string) => Promise<unknown>;
  read: (filePath: string) => Promise<unknown>;
  readRaw: (filePath: string) => Promise<unknown>;
  write: (filePath: string, content: string) => Promise<unknown>;
  edit: (filePath: string, oldString: string, newString: string) => Promise<unknown>;
  glob: (pattern: string, path?: string) => Promise<unknown>;
  grep: (pattern: string, path?: string | null, glob?: string | null, maxCount?: number | null) => Promise<unknown>;
};

afterEach(async () => {
  vi.restoreAllMocks();
  const roots = cleanupRoots.splice(0);
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

function createTestBackend(input: {
  paths?: RocPaths;
  selectedSkillIds?: readonly string[];
  workspacePath?: string;
} = {}) {
  const paths = input.paths === undefined ? new RocPaths('F:\\Code\\Roc\\.test-data') : input.paths;
  const selectedSkillIds = input.selectedSkillIds === undefined ? [] : input.selectedSkillIds;
  const selectedWorkspacePath = input.workspacePath === undefined ? workspacePath : input.workspacePath;
  return createBackend({
    workspaceService: {
      getCurrentWorkspace: () => ({ path: selectedWorkspacePath, label: 'Roc' })
    } as unknown as Parameters<typeof createBackend>[0]['workspaceService'],
    paths,
    store: new InMemoryStore(),
    securityScan: new SecurityScanService(defaultSettings.memory.securityScan),
    capacity: new CapacityService(defaultSettings.memory.charLimits),
    selectedSkillIds
  });
}

async function createSkillsFixture(skillIds: readonly string[]): Promise<RocPaths> {
  const root = await mkdtemp(join(tmpdir(), 'roc-backend-'));
  cleanupRoots.push(root);
  const paths = new RocPaths(root);
  for (const skillId of skillIds) {
    const skillDir = join(paths.skillsDir, skillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skillId}\ndescription: ${skillId}\n---\n# ${skillId}\n`, 'utf8');
  }
  return paths;
}

describe('DeepAgents Roc backend', () => {
  it('does not expose execute on the filesystem backend passed to DeepAgents', () => {
    const { backend } = createTestBackend();

    expect('execute' in backend).toBe(false);
    expect(Reflect.get(backend, 'execute')).toBeUndefined();
  });

  it('keeps Roc virtual route prefixes for file tools', () => {
    const { backend } = createTestBackend();

    expect(backend.routePrefixes).toEqual(
      expect.arrayContaining(['/workspace/', '/skills/', '/memory/global/', '/memory/workspaces/current/'])
    );
    expect(backend.routePrefixes).not.toContain('/memory/');
    expect(backend.routePrefixes).not.toContain('/agents/');
  });

  it('keeps unknown file routes as hard errors', async () => {
    const { backend } = createTestBackend();

    await expect(backend.write('/home/user/workarea/create_docx.py', 'print(1)')).resolves.toEqual({
      error: ROC_FILE_TOOL_ROUTE_ERROR
    });
  });

  it.each([
    ['ls', async (backend: TestBackend) => await backend.ls('/')],
    ['glob', async (backend: TestBackend) => await backend.glob('**/*', '/')],
    ['grep', async (backend: TestBackend) => await backend.grep('needle', '/')]
  ])('rejects root %s instead of returning an empty result', async (_name, call) => {
    const { backend } = createTestBackend();

    await expect(call(backend as TestBackend)).resolves.toEqual({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  });

  it.each([
    ['ls', async (backend: TestBackend) => await backend.ls('/agents')],
    ['read', async (backend: TestBackend) => await backend.read('/agents/AGENTS.md')],
    ['readRaw', async (backend: TestBackend) => await backend.readRaw('/agents/AGENTS.md')],
    ['write', async (backend: TestBackend) => await backend.write('/agents/notes.md', 'x')],
    ['edit', async (backend: TestBackend) => await backend.edit('/agents/notes.md', 'x', 'y')],
    ['glob', async (backend: TestBackend) => await backend.glob('**/*', '/agents')],
    ['grep', async (backend: TestBackend) => await backend.grep('needle', '/agents')]
  ])('rejects unknown route through backend method %s', async (_name, call) => {
    const { backend } = createTestBackend();

    await expect(call(backend as TestBackend)).resolves.toEqual({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  });

  it('rejects Windows absolute paths at the backend boundary', async () => {
    const { backend } = createTestBackend();

    await expect(backend.read('F:\\Code\\Roc\\package.json')).resolves.toEqual({
      error: ROC_FILE_TOOL_WINDOWS_PATH_ERROR
    });
  });

  it('allows routed workspace paths through the backend boundary', async () => {
    const { backend } = createTestBackend();

    await expect((backend as TestBackend).ls('/workspace/')).resolves.toHaveProperty('files');
  });

  it('overwrites existing workspace files through write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roc-workspace-'));
    cleanupRoots.push(root);
    const targetPath = join(root, 'notes.md');
    await writeFile(targetPath, 'before', 'utf8');
    const { backend } = createTestBackend({ workspacePath: root });

    await expect((backend as TestBackend).write('/workspace/notes.md', 'after')).resolves.not.toHaveProperty('error');
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('after');
  });

  it('denies skill files when no skills are enabled for the run', async () => {
    const paths = await createSkillsFixture(['typescript']);
    const { backend } = createTestBackend({ paths, selectedSkillIds: [] });

    await expect((backend as TestBackend).ls('/skills/')).resolves.toEqual({ files: [] });
    await expect((backend as TestBackend).read('/skills/typescript/SKILL.md')).resolves.toEqual({
      error: 'Roc 当前回合未启用这个 skill。'
    });
  });

  it('filters selected skill grep matches before applying maxCount', async () => {
    const paths = await createSkillsFixture(['a-disabled', 'z-enabled']);
    const grep = vi.spyOn(FilesystemBackend.prototype, 'grep').mockResolvedValue({
      matches: [
        { path: '/a-disabled/SKILL.md', line: 1, text: 'needle' },
        { path: '/z-enabled/SKILL.md', line: 1, text: 'needle' },
        { path: '/z-enabled/REFERENCE.md', line: 1, text: 'needle' }
      ]
    });
    const { backend } = createTestBackend({ paths, selectedSkillIds: ['z-enabled'] });

    await expect((backend as TestBackend).grep('needle', '/skills/', null, 1)).resolves.toEqual({
      matches: [{ path: '/skills/z-enabled/SKILL.md', line: 1, text: 'needle' }],
      truncated: true
    });
    expect(grep).toHaveBeenCalledWith('needle', '/', null);
  });

  it('preserves glob truncation metadata after filtering selected skills', async () => {
    const paths = await createSkillsFixture(['disabled', 'enabled']);
    vi.spyOn(FilesystemBackend.prototype, 'glob').mockResolvedValue({
      files: [
        { path: '/disabled/SKILL.md', is_dir: false },
        { path: '/enabled/SKILL.md', is_dir: false }
      ],
      truncated: true
    });
    const { backend } = createTestBackend({ paths, selectedSkillIds: ['enabled'] });

    await expect((backend as TestBackend).glob('**/*', '/skills/')).resolves.toEqual({
      files: [{ path: '/skills/enabled/SKILL.md', is_dir: false }],
      truncated: true
    });
  });

  it('uses an explicit final deny rule because DeepAgents permissions default to allow', () => {
    expect(createRocFilesystemPermissions()).toEqual([
      { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
      { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
    ]);
  });
});
