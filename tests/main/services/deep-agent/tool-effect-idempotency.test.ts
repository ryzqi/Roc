import Database from 'better-sqlite3';
import { ToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';
import { createToolEffectIdempotencyMiddleware } from '../../../../src/main/services/deep-agent/tool-effect-idempotency';

let db: Database.Database;
let store: AgentToolEffectStore;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
  store = new AgentToolEffectStore(db);
});

afterEach(() => {
  db.close();
});

describe('createToolEffectIdempotencyMiddleware', () => {
  it('reuses a successful side-effecting tool result for the same run, tool call, and input', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store
    });
    const handler = vi.fn(async () => new ToolMessage({ tool_call_id: 'call_1', name: 'run_shell_command', content: 'ran' }));
    const request = {
      toolCall: {
        id: 'call_1',
        name: 'run_shell_command',
        args: { command: 'pnpm typecheck', cwd: 'F:\\Code\\Roc' }
      }
    };

    const first = await middleware.wrapToolCall?.(request as never, handler as never);
    const second = await middleware.wrapToolCall?.(request as never, handler as never);

    expect(ToolMessage.isInstance(first)).toBe(true);
    expect(ToolMessage.isInstance(second)).toBe(true);
    expect((second as ToolMessage).content).toBe('ran');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('blocks a side-effecting tool call when the stable tool call id is missing', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store
    });
    const handler = vi.fn(async () => new ToolMessage({ tool_call_id: 'missing', name: 'run_shell_command', content: 'ran' }));

    const result = await middleware.wrapToolCall?.(
      {
        toolCall: {
          name: 'run_shell_command',
          args: { command: 'pnpm typecheck' }
        }
      } as never,
      handler as never
    );

    expect(ToolMessage.isInstance(result)).toBe(true);
    expect((result as ToolMessage).content).toBe('agent_tool_effect_call_id_missing');
    expect((result as ToolMessage).status).toBe('error');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not require a tool call id for read-only built-in tools', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store
    });
    const handler = vi.fn(async () => new ToolMessage({ tool_call_id: 'read', name: 'read_file', content: 'contents' }));

    const result = await middleware.wrapToolCall?.(
      {
        toolCall: {
          name: 'read_file',
          args: { file_path: '/workspace/package.json' }
        }
      } as never,
      handler as never
    );

    expect((result as ToolMessage).content).toBe('contents');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('treats MCP tools as side-effecting unless metadata marks them read-only', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store
    });
    const handler = vi.fn(async () => new ToolMessage({ tool_call_id: 'mcp-read', name: 'server__read', content: 'ok' }));

    const blocked = await middleware.wrapToolCall?.(
      {
        toolCall: {
          name: 'server__mutate',
          args: {}
        }
      } as never,
      handler as never
    );
    const allowed = await middleware.wrapToolCall?.(
      {
        tool: {
          name: 'server__read',
          metadata: { readOnlyHint: true }
        },
        toolCall: {
          name: 'server__read',
          args: {}
        }
      } as never,
      handler as never
    );

    expect((blocked as ToolMessage).content).toBe('agent_tool_effect_call_id_missing');
    expect((allowed as ToolMessage).content).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
