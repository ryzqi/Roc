import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { createBackend } from '../../src/main/services/deep-agent/backend';

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
  it('preserves /workspace and /skills routes while exposing execute', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-backend-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'hello backend\n', 'utf8');
      writeFileSync(join(services.paths.skillsDir, 'project-review', 'SKILL.md'), '# skill\n', 'utf8');

      const backend = createBackend(services.workspaceService, services.paths, services.shellExecutionService);
      const workspaceFiles = await backend.ls('/workspace/');
      const skillFiles = await backend.ls('/skills/project-review/');

      expect(workspaceFiles.files?.map((entry) => entry.path)).toContain('/workspace/notes.txt');
      expect(skillFiles.files?.map((entry) => entry.path)).toContain('/skills/project-review/SKILL.md');
      expect(typeof backend.execute).toBe('function');
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
      const backend = createBackend(services.workspaceService, services.paths, {
        executeAgentCommand: (input: { command: string; cwd?: string }) =>
          services.shellExecutionService.executeAgentCommand({
            ...input,
            threadId: task.threadId,
            runId: task.id
          })
      } as never);

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
});
