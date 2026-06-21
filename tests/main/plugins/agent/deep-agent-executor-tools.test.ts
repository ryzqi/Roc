import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { tagForgeMessage } from '../../../../src/main/services/forge-guardrails';
import {
  buildExecutorOnce,
  collectExecutorEvents,
  createCapabilities,
  createControlledAsyncStream,
  createDeferred,
  createMcpTool,
  drainIterator,
  findTool,
  invokeTool,
  isChatRunEventBuffer,
  readBuildInput,
  readBuiltTools,
  readIteratorValue,
  readJson,
  startExecutorExecution,
  waitForPromise,
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
    expect(buildInput.systemPrompt).toContain('Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.');
    expect(buildInput.systemPrompt).toContain('Never pass /workspace/... to run_shell_command; use a relative path from the default cwd or a real Windows path.');
    expect(buildInput.systemPrompt).toContain('Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, or grep.');
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

    expect(toolNames).not.toContain('resolve_background_task_time');
    expect(toolNames).not.toContain('propose_background_task');
    expect(toolNames).not.toContain('schedule_background_task');
    expect(toolNames).not.toContain('read_background_task');
    expect(toolNames).not.toContain('update_background_task');
    expect(toolNames).not.toContain('cancel_background_task');
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
        source: 'agent'
      }
    });
  });


  it('rejects background task workflow hints without workbench source', async () => {
    await expect(
      buildExecutorOnce(createCapabilities([]), {
        workflowHint: 'propose_background_task',
        taskSource: null
      })
    ).rejects.toThrow('background_task_workbench_source_required');
  });

});

