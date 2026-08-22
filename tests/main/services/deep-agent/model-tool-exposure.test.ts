import { describe, expect, it, vi } from 'vitest';

import {
  PLAN_MODE_BLOCKED_TOOL_NAMES,
  createRocPlanRuntimeToolGuardMiddleware,
  createRocPlanToolExposureMiddleware,
  filterPlanModeModelTools
} from '../../../../src/main/services/deep-agent/model-tool-exposure';

type NamedTool = {
  name: string;
};

function tool(name: string): NamedTool {
  return { name };
}

describe('plan mode model tool exposure', () => {
  it('filters local mutation, execution, and task-commit tools while preserving MCP tools in plan mode', () => {
    const tools = [
      tool('ls'),
      tool('read_file'),
      tool('glob'),
      tool('grep'),
      tool('web_read'),
      tool('web_search'),
      tool('ask_user'),
      tool('session_search'),
      tool('memory_search'),
      tool('remember'),
      tool('mcp_docs_lookup'),
      tool('filesystem__search'),
      tool('filesystem__write_file'),
      tool('filesystem__edit_file'),
      tool('filesystem__delete_file'),
      tool('write_file'),
      tool('edit_file'),
      tool('delete_file'),
      tool('run_shell_command'),
      tool('execute'),
      tool('task'),
      tool('write_todos'),
      tool('resolve_background_task_time'),
      tool('propose_background_task'),
      tool('schedule_background_task'),
      tool('read_background_task'),
      tool('update_background_task'),
      tool('cancel_background_task')
    ];

    expect(filterPlanModeModelTools(tools).map((candidate) => candidate.name)).toEqual(
      [
        'ls',
        'read_file',
        'glob',
        'grep',
        'web_read',
        'web_search',
        'ask_user',
        'session_search',
        'memory_search',
        'mcp_docs_lookup',
        'filesystem__search',
        'filesystem__write_file',
        'filesystem__edit_file',
        'filesystem__delete_file',
        'task',
        'write_todos',
        'resolve_background_task_time',
        'read_background_task'
      ]
    );
    expect(PLAN_MODE_BLOCKED_TOOL_NAMES).toEqual([
      'write_file',
      'edit_file',
      'delete_file',
      'remember',
      'run_shell_command',
      'execute',
      'propose_background_task',
      'schedule_background_task',
      'update_background_task',
      'cancel_background_task'
    ]);
  });

  it('does not expose tools without a string name', () => {
    const tools: unknown[] = [
      tool('ls'),
      { type: 'server_tool' },
      { name: 42 },
      null
    ];

    expect(filterPlanModeModelTools(tools)).toEqual([tool('ls')]);
  });

  it('filters request tools before the model call', async () => {
    const middleware = createRocPlanToolExposureMiddleware();
    const wrapModelCall = Reflect.get(middleware as object, 'wrapModelCall');
    if (typeof wrapModelCall !== 'function') {
      throw new Error('expected_wrap_model_call');
    }

    const handler = vi.fn(async (request: { tools?: NamedTool[] }) =>
      request.tools?.map((candidate) => candidate.name)
    );

    const output = await wrapModelCall(
      {
        tools: [
          tool('ls'),
          tool('write_file'),
          tool('edit_file'),
          tool('delete_file'),
          tool('filesystem__edit_file'),
          tool('filesystem__write_file'),
          tool('web_read'),
          tool('web_search'),
          tool('run_shell_command'),
          tool('execute'),
          tool('schedule_background_task'),
          tool('update_background_task'),
          tool('task'),
          tool('mcp_docs_lookup'),
          tool('session_search')
        ]
      },
      handler
    );

    expect(output).toEqual([
      'ls',
      'filesystem__edit_file',
      'filesystem__write_file',
      'web_read',
      'web_search',
      'task',
      'mcp_docs_lookup',
      'session_search'
    ]);
    expect(handler).toHaveBeenCalledWith({
      tools: [
        tool('ls'),
        tool('filesystem__edit_file'),
        tool('filesystem__write_file'),
        tool('web_read'),
        tool('web_search'),
        tool('task'),
        tool('mcp_docs_lookup'),
        tool('session_search')
      ]
    });
  });

  it.each(['write_file', 'run_shell_command', 'schedule_background_task'])(
    'blocks hidden local %s calls at runtime in plan mode',
    async (toolName) => {
      const middleware = createRocPlanRuntimeToolGuardMiddleware();
      const wrapToolCall = Reflect.get(middleware as object, 'wrapToolCall');
      if (typeof wrapToolCall !== 'function') {
        throw new Error('expected_wrap_tool_call');
      }

      const handler = vi.fn(async () => {
        throw new Error(`${toolName}_handler_should_not_run`);
      });

      const result = await wrapToolCall(
        {
          toolCall: {
            id: `call_${toolName}`,
            name: toolName,
            args: {
              file_path: '/workspace/plan.md',
              content: 'mutating content'
            }
          }
        },
        handler
      );

      expect(handler).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        name: toolName,
        tool_call_id: `call_${toolName}`,
        status: 'error',
        content: `Plan Mode blocks local mutation, execution, or task-commit tool calls: ${toolName}.`
      });
    }
  );

  it('allows non-file-mutating runtime tools through the guard', async () => {
    const middleware = createRocPlanRuntimeToolGuardMiddleware();
    const wrapToolCall = Reflect.get(middleware as object, 'wrapToolCall');
    if (typeof wrapToolCall !== 'function') {
      throw new Error('expected_wrap_tool_call');
    }

    const handler = vi.fn(async () => 'read result');

    await expect(
      wrapToolCall(
        {
          toolCall: {
            id: 'call_read',
            name: 'read_file',
            args: {
              file_path: '/workspace/README.md'
            }
          }
        },
        handler
      )
    ).resolves.toBe('read result');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('allows MCP runtime tools through the guard', async () => {
    const middleware = createRocPlanRuntimeToolGuardMiddleware();
    const wrapToolCall = Reflect.get(middleware as object, 'wrapToolCall');
    if (typeof wrapToolCall !== 'function') {
      throw new Error('expected_wrap_tool_call');
    }

    const handler = vi.fn(async () => 'mcp result');

    await expect(
      wrapToolCall(
        {
          toolCall: {
            id: 'call_mcp',
            name: 'mcp_docs_lookup',
            args: {
              query: 'plan mode'
            }
          }
        },
        handler
      )
    ).resolves.toBe('mcp result');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('allows MCP namespaced tools through the plan guard', async () => {
    const middleware = createRocPlanRuntimeToolGuardMiddleware();
    const wrapToolCall = Reflect.get(middleware as object, 'wrapToolCall');
    if (typeof wrapToolCall !== 'function') {
      throw new Error('expected_wrap_tool_call');
    }

    const handler = vi.fn(async () => 'mcp namespaced result');

    await expect(
      wrapToolCall(
        {
          toolCall: {
            id: 'call_mcp_filesystem',
            name: 'filesystem__write_file',
            args: {
              path: '/workspace/plan.md',
              content: 'delegated to MCP policy'
            }
          }
        },
        handler
      )
    ).resolves.toBe('mcp namespaced result');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
