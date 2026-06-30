import { describe, expect, it, vi } from 'vitest';

import {
  PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES,
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
  it('keeps only the plan mode model-visible allowlist', () => {
    const tools = [
      tool('ls'),
      tool('read_file'),
      tool('glob'),
      tool('grep'),
      tool('web_read'),
      tool('ask_user'),
      tool('session_search'),
      tool('write_file'),
      tool('edit_file'),
      tool('delete_file'),
      tool('run_shell_command'),
      tool('execute'),
      tool('task'),
      tool('write_todos'),
      tool('filesystem__search'),
      tool('resolve_background_task_time'),
      tool('propose_background_task'),
      tool('schedule_background_task'),
      tool('read_background_task'),
      tool('update_background_task'),
      tool('cancel_background_task')
    ];

    expect(filterPlanModeModelTools(tools).map((candidate) => candidate.name)).toEqual(
      PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES
    );
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
          tool('web_read'),
          tool('task'),
          tool('session_search')
        ]
      },
      handler
    );

    expect(output).toEqual(['ls', 'web_read', 'session_search']);
    expect(handler).toHaveBeenCalledWith({
      tools: [tool('ls'), tool('web_read'), tool('session_search')]
    });
  });
});
