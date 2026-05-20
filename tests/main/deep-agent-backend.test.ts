import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@langchain/langgraph';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { createBackend, type RocCompositeBackend } from '../../src/main/services/deep-agent/backend';
import { buildDeepAgentMemoryNamespace } from '../../src/main/services/deep-agent/sqlite-store';

let root: string;
let userHome: string;
let previousUserProfile: string | undefined;
let services: AppServices;

function createShellExecutionAdapter(overrides?: { threadId?: string; runId?: string }) {
  return {
    executeAgentCommand: async (input: { command: string; cwd?: string }) =>
      await services.shellExecutionService.executeAgentCommandAsync({
        ...input,
        threadId: overrides?.threadId,
        runId: overrides?.runId
      })
  } as const;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-deep-agent-backend-'));
  userHome = mkdtempSync(join(tmpdir(), 'roc-deep-agent-backend-home-'));
  previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = userHome;
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

describe('deep agent backend', () => {
  it('preserves /workspace, /skills, /agents, and /memory routes while exposing execute through the default bridge', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'hello backend\n', 'utf8');
      writeFileSync(join(services.paths.skillsDir, 'project-review', 'SKILL.md'), '# skill\n', 'utf8');
      const store = new InMemoryStore();
      await store.put([...buildDeepAgentMemoryNamespace(workspaceRoot)], '/accepted.md', {
        content: '# accepted\n',
        created_at: '2026-05-15T00:00:00.000Z',
        modified_at: '2026-05-15T00:00:00.000Z',
        mimeType: 'text/markdown'
      });

      const runtimeBackend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: createShellExecutionAdapter(),
        store
      });
      const backend = runtimeBackend.backend;
      const workspaceFiles = await backend.ls('/workspace/');
      const skillFiles = await backend.ls('/skills/project-review/');
      const agentsFiles = await backend.ls('/agents/');
      const agentsRule = await backend.read('/agents/AGENTS.md');
      const memoryFiles = await backend.ls('/memory/');
      const rootFiles = await backend.ls('/');

      expect(workspaceFiles.files?.map((entry) => entry.path)).toContain('/workspace/notes.txt');
      expect(skillFiles.files?.map((entry) => entry.path)).toContain('/skills/project-review/SKILL.md');
      expect(agentsFiles.files?.map((entry) => entry.path)).toContain('/agents/AGENTS.md');
      expect(agentsRule.content).toContain('# Roc Project Rules');
      expect(memoryFiles.files?.map((entry) => entry.path)).toContain('/memory/accepted.md');
      expect(rootFiles.files?.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(['/workspace/', '/skills/', '/agents/', '/memory/'])
      );
      expect(typeof backend.execute).toBe('function');
      expect(runtimeBackend.memoryRoute).toBe('/memory/');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('lists all mounted skills from the read-only /skills/ route without backend-level filtering', async () => {
    mkdirSync(join(services.paths.skillsDir, 'alpha-review'), { recursive: true });
    mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
    writeFileSync(join(services.paths.skillsDir, 'alpha-review', 'SKILL.md'), '# alpha review\n', 'utf8');
    writeFileSync(join(services.paths.skillsDir, 'project-review', 'SKILL.md'), '# project review\n', 'utf8');

    const backend = createBackend({
      workspaceService: services.workspaceService,
      paths: services.paths,
      shellExecutionService: createShellExecutionAdapter(),
      store: new InMemoryStore()
    }).backend;

    const rootSkills = await backend.ls('/skills/');
    const projectSkillFile = await backend.read('/skills/project-review/SKILL.md');
    const alphaSkillDirectory = await backend.ls('/skills/alpha-review/');
    const rootSkillGrep = await backend.grep('review', '/skills/');
    const directAlphaGrep = await backend.grep('alpha', '/skills/alpha-review/');
    const rootSkillGlob = await backend.glob('**/*.md', '/skills/');
    const directAlphaGlob = await backend.glob('**/*.md', '/skills/alpha-review/');

    expect(rootSkills.files?.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['/skills/alpha-review/', '/skills/project-review/'])
    );
    expect(projectSkillFile.content).toBe('# project review\n');
    expect(alphaSkillDirectory.files?.map((entry) => entry.path)).toEqual(['/skills/alpha-review/SKILL.md']);
    expect(rootSkillGrep.matches?.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['/skills/alpha-review/SKILL.md', '/skills/project-review/SKILL.md'])
    );
    expect(directAlphaGrep.matches?.map((entry) => entry.path)).toEqual(['/skills/alpha-review/SKILL.md']);
    expect(rootSkillGlob.files?.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['/skills/alpha-review/SKILL.md', '/skills/project-review/SKILL.md'])
    );
    expect(directAlphaGlob.files?.map((entry) => entry.path)).toEqual(['/skills/alpha-review/SKILL.md']);
  });

  it('runs agent execute in the selected workspace and records bypass metadata when rtk is missing', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-execute-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      writeFileSync(join(workspaceRoot, 'backend-note.txt'), 'backend execute\n', 'utf8');
      const task = services.taskService.createTaskRun({
        userInput: '列出工作区文件',
        modelId: 'model-ready',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      services.taskService.markRunRunning(task.id);
      const backend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: createShellExecutionAdapter({
          threadId: task.threadId,
          runId: task.id
        }),
        store: new InMemoryStore()
      }).backend;

      const result = await backend.execute('dir');
      const snapshot = services.taskService.getSnapshot();
      const agentEvent = snapshot.recentEvents.find((event) => event.runId === task.id && event.type === 'agent_execute');

      expect(result).toMatchObject({
        exitCode: 0,
        truncated: false,
        output: expect.stringContaining('backend-note.txt')
      });
      expect(agentEvent?.payload).toMatchObject({
        command: 'dir',
        cwd: workspaceRoot,
        usedRtk: false,
        bypassReason: 'rtk_binary_missing'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('writes and edits /workspace files on disk', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-write-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const backend: RocCompositeBackend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: createShellExecutionAdapter(),
        store: new InMemoryStore()
      }).backend;

      const writeResult = await backend.write('/workspace/notes.md', 'alpha\n');
      const editResult = await backend.edit('/workspace/notes.md', 'alpha', 'beta');

      expect(writeResult.error).toBeUndefined();
      expect(writeResult.path).toBe('/notes.md');
      expect(editResult.error).toBeUndefined();
      expect(editResult.path).toBe('/notes.md');
      expect(readFileSync(join(workspaceRoot, 'notes.md'), 'utf8')).toBe('beta\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps /skills/ mounted read-only during agent runs', async () => {
    mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
    writeFileSync(
      join(services.paths.skillsDir, 'project-review', 'SKILL.md'),
      '---\nname: project-review\ndescription: project review\n---\n',
      'utf8'
    );
    const backend: RocCompositeBackend = createBackend({
      workspaceService: services.workspaceService,
      paths: services.paths,
      shellExecutionService: createShellExecutionAdapter(),
      store: new InMemoryStore()
    }).backend;

    const writeResult = await backend.write('/skills/project-review/notes.md', 'mutate\n');
    const editResult = await backend.edit('/skills/project-review/SKILL.md', 'project review', 'mutated');

    expect(writeResult.error).toBeTruthy();
    expect(editResult.error).toBeTruthy();
    expect(readFileSync(join(services.paths.skillsDir, 'project-review', 'SKILL.md'), 'utf8')).toContain(
      'description: project review'
    );
  });

  it('keeps /memory/ mounted read-only as a curated projection during agent runs', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-memory-readonly-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const store = new InMemoryStore();
      await store.put([...buildDeepAgentMemoryNamespace(workspaceRoot)], '/accepted.md', {
        content: '# accepted\n',
        created_at: '2026-05-15T00:00:00.000Z',
        modified_at: '2026-05-15T00:00:00.000Z',
        mimeType: 'text/markdown'
      });
      const backend: RocCompositeBackend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: createShellExecutionAdapter(),
        store
      }).backend;

      const writeResult = await backend.write('/memory/accepted.md', 'mutate\n');
      const editResult = await backend.edit('/memory/accepted.md', '# accepted\n', 'mutated');
      const memoryFile = await backend.read('/memory/accepted.md');

      expect(writeResult.error).toBeTruthy();
      expect(editResult.error).toBeTruthy();
      expect(memoryFile.content).toBe('# accepted\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('allows writes outside the mounted routes through the default StateBackend', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-invalid-route-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const backend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: createShellExecutionAdapter(),
        store: new InMemoryStore()
      }).backend;

      const appWrite = await backend.write('/app/hello.txt', 'bad\n');
      const rootWrite = await backend.write('/hello.txt', 'bad\n');

      expect(appWrite.error).toBeUndefined();
      expect(appWrite.path).toBe('/app/hello.txt');
      expect(rootWrite.error).toBeUndefined();
      expect(rootWrite.path).toBe('/hello.txt');
      expect(existsSync(join(workspaceRoot, 'hello.txt'))).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('allows root-scoped grep and glob aggregation across mounted routes', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-root-search-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'hello backend\n', 'utf8');
      writeFileSync(join(services.paths.skillsDir, 'project-review', 'SKILL.md'), '# hello skill\n', 'utf8');
      const store = new InMemoryStore();
      await store.put([...buildDeepAgentMemoryNamespace(workspaceRoot)], '/accepted.md', {
        content: 'hello memory\n',
        created_at: '2026-05-15T00:00:00.000Z',
        modified_at: '2026-05-15T00:00:00.000Z',
        mimeType: 'text/markdown'
      });

      const backend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: createShellExecutionAdapter(),
        store
      }).backend;

      const grepResult = await backend.grep('hello', '/');
      const globResult = await backend.glob('**/*.md', '/');

      expect(grepResult.error).toBeUndefined();
      expect(grepResult.matches?.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(['/workspace/notes.txt', '/skills/project-review/SKILL.md', '/memory/accepted.md'])
      );
      expect(globResult.error).toBeUndefined();
      expect(globResult.files?.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(['/skills/project-review/SKILL.md', '/memory/accepted.md'])
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('allows uploadFiles for paths outside mounted routes through the default StateBackend', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-upload-invalid-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const backend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: createShellExecutionAdapter(),
        store: new InMemoryStore()
      }).backend;

      const responses = await backend.uploadFiles([
        ['/workspace/ok.txt', new TextEncoder().encode('ok')],
        ['/app/not-allowed.txt', new TextEncoder().encode('bad')]
      ]);

      expect(responses).toEqual([
        {
          path: '/workspace/ok.txt',
          error: null
        },
        {
          path: '/app/not-allowed.txt',
          error: null
        }
      ]);
      expect(existsSync(join(workspaceRoot, 'ok.txt'))).toBe(true);
      expect(existsSync(join(workspaceRoot, 'not-allowed.txt'))).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
