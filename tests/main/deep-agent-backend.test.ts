import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@langchain/langgraph';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { createBackend, type RocCompositeBackend } from '../../src/main/services/deep-agent/backend';

let root: string;
let userHome: string;
let previousUserProfile: string | undefined;
let services: AppServices;

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
  it('preserves /workspace, /skills, and /memory routes while exposing execute through the default bridge', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'hello backend\n', 'utf8');
      writeFileSync(join(services.paths.skillsDir, 'project-review', 'SKILL.md'), '# skill\n', 'utf8');
      const store = new InMemoryStore();
      await store.put(['roc', 'memory', 'filesystem'], '/accepted.md', {
        content: '# accepted\n',
        created_at: '2026-05-15T00:00:00.000Z',
        modified_at: '2026-05-15T00:00:00.000Z',
        mimeType: 'text/markdown'
      });

      const runtimeBackend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: services.shellExecutionService,
        store
      });
      const backend = runtimeBackend.backend;
      const workspaceFiles = await backend.ls('/workspace/');
      const skillFiles = await backend.ls('/skills/project-review/');
      const memoryFiles = await backend.ls('/memory/');
      const rootFiles = await backend.ls('/');

      expect(workspaceFiles.files?.map((entry) => entry.path)).toContain('/workspace/notes.txt');
      expect(skillFiles.files?.map((entry) => entry.path)).toContain('/skills/project-review/SKILL.md');
      expect(memoryFiles.files?.map((entry) => entry.path)).toContain('/memory/accepted.md');
      expect(rootFiles.files?.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(['/workspace/', '/skills/', '/memory/'])
      );
      expect(typeof backend.execute).toBe('function');
      expect(runtimeBackend.memoryRoute).toBe('/memory/');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
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
        shellExecutionService: {
          executeAgentCommand: (input: { command: string; cwd?: string }) =>
          services.shellExecutionService.executeAgentCommand({
            ...input,
            threadId: task.threadId,
            runId: task.id
          })
        } as never,
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
        shellExecutionService: services.shellExecutionService,
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

  it('rejects writes outside the mounted routes', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-invalid-route-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const backend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: services.shellExecutionService,
        store: new InMemoryStore()
      }).backend;

      const appWrite = await backend.write('/app/hello.txt', 'bad\n');
      const rootWrite = await backend.write('/hello.txt', 'bad\n');

      expect(appWrite.error).toBeTruthy();
      expect(appWrite.path).toBeUndefined();
      expect(rootWrite.error).toBeTruthy();
      expect(rootWrite.path).toBeUndefined();
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
      await store.put(['roc', 'memory', 'filesystem'], '/accepted.md', {
        content: 'hello memory\n',
        created_at: '2026-05-15T00:00:00.000Z',
        modified_at: '2026-05-15T00:00:00.000Z',
        mimeType: 'text/markdown'
      });

      const backend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: services.shellExecutionService,
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

  it('rejects uploadFiles for paths outside mounted routes', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-upload-invalid-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const backend = createBackend({
        workspaceService: services.workspaceService,
        paths: services.paths,
        shellExecutionService: services.shellExecutionService,
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
          error: 'invalid_path'
        }
      ]);
      expect(existsSync(join(workspaceRoot, 'ok.txt'))).toBe(true);
      expect(existsSync(join(workspaceRoot, 'not-allowed.txt'))).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
