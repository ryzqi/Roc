import { describe, expect, it } from 'vitest';
import {
  buildExecutorOnce,
  createCapabilities,
  createMcpTool,
  findTool,
  invokeTool,
  readBuildInput,
  readJson,
  readBuiltTools,
  workspacePath
} from './deep-agent-executor-test-helpers';

describe('createAgentDeepAgentExecutor', () => {
  it('uses the shared workflow system prompt in production executor runs', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });

    const buildInput = readBuildInput();
    expect(buildInput.systemPrompt).toContain('本轮工作流：创建后台任务。');
    expect(buildInput.systemPrompt).toContain('DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.');
    expect(buildInput.systemPrompt).toContain('Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.');
    expect(buildInput.systemPrompt).toContain('write_file only creates new files. To change an existing file, read it first, then use edit_file with an exact replacement.');
    expect(buildInput.systemPrompt).toContain('Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.');
    expect(buildInput.systemPrompt).toContain('Never pass /workspace/... to run_shell_command; use a relative path from the default cwd or a real Windows path.');
    expect(buildInput.systemPrompt).toContain('Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.');
    expect(buildInput.systemPrompt).not.toContain('current directory means /workspace/.');
    expect(buildInput.systemPrompt).not.toContain('schedule_background_task({ previewId })');
  });


  it('adds background task change interrupts inside workbench background task workflows', async () => {
    await buildExecutorOnce(createCapabilities([], { capabilityPreview: true }), {
      workflowHint: 'background_task_change',
      taskSource: 'workbench'
    });

    expect(readBuildInput().interruptOn).toEqual({
      update_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      cancel_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      }
    });
  });


  it('does not expose background task tools in ordinary chat runs', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    const toolNames = readBuiltTools().map((tool) => tool.name);

    expect(toolNames).toContain('session_search');
    expect(toolNames).not.toContain('resolve_background_task_time');
    expect(toolNames).not.toContain('propose_background_task');
    expect(toolNames).not.toContain('schedule_background_task');
    expect(toolNames).not.toContain('read_background_task');
    expect(toolNames).not.toContain('update_background_task');
    expect(toolNames).not.toContain('cancel_background_task');
  });

  it('does not expose mutation tools in plan mode', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'plan',
      workflowHint: null,
      taskSource: null
    });

    const toolNames = readBuiltTools().map((tool) => tool.name);

    expect(readBuildInput().mode).toBe('plan');
    expect(toolNames).toContain('web_read');
    expect(toolNames).toContain('session_search');
    expect(toolNames).not.toContain('run_shell_command');
    expect(toolNames).not.toContain('delete_file');
    expect(toolNames).not.toContain('resolve_background_task_time');
    expect(toolNames).not.toContain('propose_background_task');
    expect(toolNames).not.toContain('schedule_background_task');
    expect(toolNames).not.toContain('read_background_task');
    expect(toolNames).not.toContain('update_background_task');
    expect(toolNames).not.toContain('cancel_background_task');
  });

  it('loads selected MCP tools into plan mode custom tools without MCP-internal filtering', async () => {
    await buildExecutorOnce(
      createCapabilities([], {
        mcpTools: [
          createMcpTool('filesystem__search'),
          createMcpTool('exa-hosted__web_search_exa')
        ]
      }),
      {
        mode: 'plan',
        workflowHint: null,
        taskSource: null,
        enabledCapabilities: {
          mcpServers: ['filesystem', 'exa-hosted'],
          skills: []
        }
      }
    );

    const toolNames = readBuiltTools().map((tool) => tool.name);

    expect(readBuildInput().mode).toBe('plan');
    expect(toolNames).toContain('web_read');
    expect(toolNames).toContain('ask_user');
    expect(toolNames).toContain('session_search');
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('web_search');
    expect(toolNames).not.toContain('run_shell_command');
    expect(toolNames).not.toContain('delete_file');
  });

  it('exposes ask_user in chat and plan tool surfaces', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });
    expect(readBuiltTools().map((tool) => tool.name)).toContain('ask_user');

    await buildExecutorOnce(createCapabilities([]), {
      mode: 'plan',
      workflowHint: null,
      taskSource: null
    });
    const planToolNames = readBuiltTools().map((tool) => tool.name);
    expect(planToolNames).toContain('ask_user');
    expect(planToolNames).not.toContain('run_shell_command');
    expect(planToolNames).not.toContain('delete_file');
  });

  it('uses read-only filesystem permissions in plan mode', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'plan',
      workflowHint: null,
      taskSource: null
    });

    expect(readBuildInput().filesystemPermissions).toEqual([
      { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/**'], mode: 'deny' }
    ]);
  });


  it('exposes Roc Windows command tool instead of DeepAgents built-in execute', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    const toolNames = readBuiltTools().map((tool) => tool.name);

    expect(toolNames).toContain('run_shell_command');
    expect(toolNames).not.toContain('execute');
  });


  it('runs Roc Windows command tool through shell.execute capability', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    const output = await invokeTool(findTool(readBuiltTools(), 'run_shell_command'), {
      command: 'python .\\create_docx.py'
    });

    expect(output).toContain('"exitCode": 0');
    expect(capabilityCalls).toContainEqual({
      name: 'shell.execute',
      input: {
        command: 'python .\\create_docx.py',
        cwd: workspacePath,
        source: 'agent',
        runId: 'run-1',
        threadId: 'thread-1',
        signal: expect.any(AbortSignal),
        allowedCommands: undefined
      }
    });
  });

  it('does not expose shell to a background snapshot without pre-authorization', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'task',
      taskSource: 'background_schedule',
      shellAllowedCommands: []
    });

    expect(readBuiltTools().map((tool) => tool.name)).not.toContain('run_shell_command');
  });


  it('converts delete_file /workspace file_path to files.delete relativePath', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    const output = await invokeTool(findTool(readBuiltTools(), 'delete_file'), {
      file_path: '/workspace/src/remove-me.ts'
    });

    expect(readJson(output)).toMatchObject({
      relativePath: 'src/remove-me.ts'
    });
    expect(capabilityCalls).toContainEqual({
      name: 'files.delete',
      input: {
        relativePath: 'src/remove-me.ts'
      }
    });
  });


  it.each([
    ['relative path', { file_path: 'src/remove-me.ts' }, 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'],
    ['memory path', { file_path: '/memory/global/MEMORY.md' }, 'delete_file 只允许删除 /workspace/ 路径下的文件或空目录。'],
    ['workspace root', { file_path: '/workspace/' }, 'delete_file 只允许删除 /workspace/ 路径下的文件或空目录。']
  ])('rejects delete_file %s', async (_label, input, message) => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    await expect(invokeTool(findTool(readBuiltTools(), 'delete_file'), input)).rejects.toThrow(message);
  });


  it('uses the frozen workbench origin to enable background task tools', async () => {
    await expect(
      buildExecutorOnce(createCapabilities([]), {
        workflowHint: 'propose_background_task',
        taskSource: 'workbench'
      })
    ).resolves.toBeUndefined();
    expect(readBuiltTools().map((tool) => tool.name)).toContain('propose_background_task');
  });

});

