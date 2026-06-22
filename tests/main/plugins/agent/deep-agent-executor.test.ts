import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BackgroundTaskPreview } from '../../../../src/shared/types';
import {
  buildExecutorOnce,
  collectExecutorEvents,
  createCapabilities,
  createMcpTool,
  findTool,
  invokeTool,
  readBuildInput,
  readBuiltTools,
  readJson,
  workspacePath
} from './deep-agent-executor-test-helpers';

describe('createAgentDeepAgentExecutor', () => {
  it('wires background task creation tools during workbench proposal runs', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
    const tools = readBuiltTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining(['resolve_background_task_time', 'propose_background_task', 'schedule_background_task', 'read_background_task'])
    );
    expect(toolNames).not.toContain('update_background_task');
    expect(toolNames).not.toContain('cancel_background_task');
    expect(capabilityCalls.map((call) => call.name)).toEqual(['workspace.getCurrent']);
  });


  it('keeps selected MCP tools and skill sources available during background task runs', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls, { mcpTools: [createMcpTool('exa-hosted__web_search_exa')] }), {
      enabledCapabilities: {
        mcpServers: ['exa-hosted'],
        skills: ['deep-review']
      },
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });

    const buildInput = readBuildInput();
    const toolNames = buildInput.tools.map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining(['web_search', 'run_shell_command', 'propose_background_task']));
    expect(buildInput.skillSources).toEqual(['/skills/']);
    expect(buildInput.systemPrompt).toContain('Capabilities: mcp=exa-hosted;skills=deep-review;');
    expect(buildInput.systemPrompt).toContain('本轮后台任务继承当前主聊天已启用的 MCP 和 skills');
    expect(capabilityCalls.map((call) => call.name)).toEqual(['workspace.getCurrent', 'mcp.tools.get']);
  });


  it('routes proposal tools to task preview and create capabilities', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
    const tools = readBuiltTools();

    const previewOutput = await invokeTool(findTool(tools, 'propose_background_task'), {
      goal: '每天中午一点创建 docx 文件，里面写你好世界',
      trigger: {
        type: 'cron',
        cronExpression: '0 13 * * *',
        nextRunAt: '2026-06-17T05:00:00.000Z'
      }
    });
    const previewJson = readJson(previewOutput) as { previewId: string };

    const scheduleOutput = await invokeTool(findTool(tools, 'schedule_background_task'), {
      previewId: previewJson.previewId
    });

    expect(readJson(scheduleOutput)).toMatchObject({
      ok: true,
      taskId: 'background-1',
      threadId: 'thread-background-1'
    });
    expect(capabilityCalls.map((call) => call.name)).toEqual([
      'workspace.getCurrent',
      'task.background.preview',
      'task.background.create'
    ]);
    const previewCall = capabilityCalls.find((call) => call.name === 'task.background.preview');
    expect(previewCall?.input).toMatchObject({
      goal: '每天中午一点创建 docx 文件，里面写你好世界',
      trigger: {
        type: 'cron',
        description: '每天 13:00 触发',
        cronExpression: '0 13 * * *',
        nextRunAt: '2026-06-17T05:00:00.000Z'
      },
      workspacePath
    });
  });


  it('uses runtime workspace path instead of model-supplied workspacePath', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });

    const output = await invokeTool(findTool(readBuiltTools(), 'propose_background_task'), {
      goal: '每天中午一点创建 docx 文件，里面写你好世界',
      trigger: {
        type: 'cron',
        cronExpression: '0 13 * * *',
        nextRunAt: '2026-06-17T05:00:00.000Z'
      },
      workspacePath: '/workspace/'
    });

    const parsed = readJson(output) as { preview: BackgroundTaskPreview };
    expect(parsed.preview.workspacePath).toBe(workspacePath);
    expect(capabilityCalls.find((call) => call.name === 'task.background.preview')?.input).toMatchObject({
      workspacePath
    });
  });


  it('binds background task runs to the saved task workspace instead of the current UI workspace', async () => {
    const taskWorkspacePath = join(workspacePath, 'scheduled-task-workspace');
    const currentWorkspacePath = join(workspacePath, 'current-ui-workspace');
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(
      createCapabilities(capabilityCalls, {
        workspace: {
          id: 'workspace-current',
          path: currentWorkspacePath,
          displayName: 'Current UI Workspace',
          lastOpenedAt: '2026-06-04T00:00:00.000Z',
          trustState: 'trusted'
        }
      }),
      {
        taskSource: 'workbench',
        workspacePath: taskWorkspacePath
      }
    );

    const buildInput = readBuildInput();
    const shellOutput = await invokeTool(findTool(buildInput.tools, 'run_shell_command'), {
      command: 'git status'
    });

    expect(buildInput.systemPrompt).toContain(`Workspace: ${taskWorkspacePath}`);
    expect(buildInput.backend.routePrefixes).toEqual(
      expect.arrayContaining(['/workspace/', '/skills/', '/memory/global/', '/memory/workspaces/current/'])
    );
    expect(buildInput.backend.routePrefixes).not.toContain('/memory/');
    expect(buildInput.memorySources).toEqual([
      '/memory/global/USER.md',
      '/memory/global/AGENTS.md',
      '/memory/global/MEMORY.md',
      '/memory/workspaces/current/AGENTS.md',
      '/memory/workspaces/current/MEMORY.md'
    ]);
    expect(readJson(shellOutput)).toMatchObject({
      cwd: taskWorkspacePath
    });
    expect(capabilityCalls.find((call) => call.name === 'shell.execute')?.input).toMatchObject({
      cwd: taskWorkspacePath
    });
  });


  it('rejects background task propose when no workspace is selected', async () => {
    await buildExecutorOnce(createCapabilities([], { workspace: null }), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
    expect(readBuildInput().memorySources).toEqual([
      '/memory/global/USER.md',
      '/memory/global/AGENTS.md',
      '/memory/global/MEMORY.md'
    ]);

    await expect(
      invokeTool(findTool(readBuiltTools(), 'propose_background_task'), {
        goal: '每天中午一点创建 docx 文件，里面写你好世界',
        trigger: {
          type: 'cron',
          cronExpression: '0 13 * * *',
          nextRunAt: '2026-06-17T05:00:00.000Z'
        }
      })
    ).rejects.toThrow('创建后台任务需要先选择工作区');
  });


  it('keeps the DeepAgents backend available during workbench proposal runs', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });

    const buildInput = readBuildInput();

    expect(buildInput.backend.routePrefixes).toEqual(
      expect.arrayContaining(['/workspace/', '/skills/', '/memory/global/', '/memory/workspaces/current/'])
    );
    expect(buildInput.backend.routePrefixes).not.toContain('/memory/');
    expect(buildInput.memorySources).toEqual([
      '/memory/global/USER.md',
      '/memory/global/AGENTS.md',
      '/memory/global/MEMORY.md',
      '/memory/workspaces/current/AGENTS.md',
      '/memory/workspaces/current/MEMORY.md'
    ]);
    expect(buildInput.backend.routePrefixes).not.toContain('/agents/');
    expect('execute' in buildInput.backend).toBe(false);
    expect(buildInput.workspacePath).toBe(workspacePath);
    expect(buildInput.filesystemPermissions).toEqual([
      { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
      { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
    ]);
  });

  it('applies current memory settings to DeepAgents memory backend writes', async () => {
    await collectExecutorEvents({
      capabilities: createCapabilities([]),
      getMemorySettings: () => ({
        charLimits: { user: 5, agents: 5, memory: 5 },
        sessionRetentionDays: 90,
        securityScan: {
          promptInjection: false,
          credential: false,
          sshBackdoor: false,
          invisibleUnicode: false
        }
      }),
      output: {
        messages: [
          {
            role: 'assistant',
            content: 'ok'
          }
        ]
      }
    });

    await expect(readBuildInput().backend.write('/memory/global/MEMORY.md', '123456')).resolves.toMatchObject({
      error: expect.stringContaining('chars: 6/5 (kind=memory)')
    });
  });


  it('wires background task change tools to task capabilities', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      workflowHint: 'background_task_change',
      taskSource: 'workbench'
    });
    const tools = readBuiltTools();

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['read_background_task', 'update_background_task', 'cancel_background_task']));

    await invokeTool(findTool(tools, 'read_background_task'), {
      taskId: 'background-1'
    });
    await invokeTool(findTool(tools, 'update_background_task'), {
      taskId: 'background-1',
      patch: {
        goal: '每天检查失败测试'
      },
      reason: '调整目标'
    });
    await invokeTool(findTool(tools, 'cancel_background_task'), {
      taskId: 'background-1',
      reason: '不再需要'
    });

    expect(capabilityCalls.map((call) => call.name)).toEqual([
      'workspace.getCurrent',
      'task.detail.get',
      'task.background.update',
      'task.background.cancel'
    ]);
  });

});
