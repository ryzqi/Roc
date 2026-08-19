import Database from 'better-sqlite3';
import { ToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentDatabaseSchema as applyAgentPluginSchema } from '../../../../src/main/infrastructure/database-schemas';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';
import { createToolEffectIdempotencyMiddleware } from '../../../../src/main/services/deep-agent/tool-effect-idempotency';
import { RocToolResolutionError } from '../../../../src/main/services/forge-guardrails';
import type { RunCapabilityManifestV1 } from '../../../../src/shared/types';

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
      store,
      capabilityManifest: manifestFor([manifestTool('run_shell_command', 'host_execution', 'tool_call')])
    });
    const handler = vi.fn(async () => new ToolMessage({ tool_call_id: 'call_1', name: 'run_shell_command', content: 'ran' }));
    const request = {
      toolCall: {
        id: 'call_1',
        name: 'run_shell_command',
        args: { command: 'pnpm typecheck', cwd: 'F:\\Code\\Roc' }
      },
      runtime: runtime('')
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
      store,
      capabilityManifest: manifestFor([manifestTool('run_shell_command', 'host_execution', 'tool_call')])
    });
    const handler = vi.fn(async () => new ToolMessage({ tool_call_id: 'missing', name: 'run_shell_command', content: 'ran' }));

    const result = await middleware.wrapToolCall?.(
      {
        toolCall: {
          name: 'run_shell_command',
          args: { command: 'pnpm typecheck' }
        },
        runtime: runtime('')
      } as never,
      handler as never
    );

    expect(ToolMessage.isInstance(result)).toBe(true);
    expect((result as ToolMessage).content).toBe('agent_tool_effect_call_id_missing');
    expect((result as ToolMessage).status).toBe('error');
    expect(handler).not.toHaveBeenCalled();
  });

  it('blocks a side-effecting tool call when execution info is missing', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([manifestTool('run_shell_command', 'host_execution', 'tool_call')])
    });
    const handler = vi.fn(async () => new ToolMessage({ tool_call_id: 'call_1', name: 'run_shell_command', content: 'ran' }));

    const result = await middleware.wrapToolCall?.(
      {
        toolCall: {
          id: 'call_1',
          name: 'run_shell_command',
          args: { command: 'pnpm typecheck' }
        }
      } as never,
      handler as never
    );

    expect((result as ToolMessage).content).toBe('agent_tool_effect_execution_info_missing');
    expect((result as ToolMessage).status).toBe('error');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not require a tool call id for read-only built-in tools', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([manifestTool('read_file', 'none', 'none')])
    });
    const handler = vi.fn(async () => new ToolMessage({ tool_call_id: 'read', name: 'read_file', content: 'contents' }));

    const result = await middleware.wrapToolCall?.(
      {
        toolCall: {
          name: 'read_file',
          args: { file_path: '/workspace/package.json' }
        },
        runtime: runtime('')
      } as never,
      handler as never
    );

    expect((result as ToolMessage).content).toBe('contents');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uses the local manifest policy instead of MCP readOnlyHint', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([
        manifestTool('server__mutate', 'external_call', 'tool_call'),
        manifestTool('server__read', 'external_call', 'tool_call')
      ])
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
    expect((allowed as ToolMessage).content).toBe('agent_tool_effect_call_id_missing');
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses the runtime checkpoint map as the subagent effect identity instead of MCP readOnlyHint', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([manifestTool('server__mutate', 'external_call', 'tool_call')])
    });
    const handler = vi.fn(async (request: { toolCall: { id: string } }) =>
      new ToolMessage({ tool_call_id: request.toolCall.id, name: 'server__mutate', content: 'ran' })
    );
    const baseRequest = {
      tool: { name: 'server__mutate', metadata: { readOnlyHint: true } },
      toolCall: { id: 'call_same', name: 'server__mutate', args: { value: 1 } }
    };

    await middleware.wrapToolCall?.({
      ...baseRequest,
      runtime: runtime('tools:research-parent', 'cp_1')
    } as never, handler as never);
    await middleware.wrapToolCall?.({
      ...baseRequest,
      runtime: runtime('tools:research-sibling', 'cp_2')
    } as never, handler as never);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(
      db.prepare(
        `SELECT execution_path AS executionPath, checkpoint_id AS checkpointId
         FROM agent_tool_effects
         ORDER BY execution_path`
      ).all()
    ).toEqual([
      {
        executionPath: 'subagent/tools:research-parent',
        checkpointId: 'cp_1'
      },
      {
        executionPath: 'subagent/tools:research-sibling',
        checkpointId: 'cp_2'
      }
    ]);
  });

  it('rejects a runtime identity whose agent type conflicts with its namespace', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([manifestTool('run_shell_command', 'host_execution', 'tool_call')])
    });
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call_mismatch',
      name: 'run_shell_command',
      content: 'ran'
    }));

    const result = await middleware.wrapToolCall?.(
      {
        toolCall: {
          id: 'call_mismatch',
          name: 'run_shell_command',
          args: { command: 'pnpm typecheck' }
        },
        runtime: {
          configurable: {
            ls_agent_type: 'root',
            checkpoint_ns: 'tools:research-parent|tools:call-mismatch',
            checkpoint_map: { 'tools:research-parent': 'cp_mismatch' }
          }
        }
      } as never,
      handler as never
    );

    expect((result as ToolMessage).content).toBe('agent_tool_effect_execution_info_missing');
    expect((result as ToolMessage).status).toBe('error');
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows a retry-safe effect to retry after a retryable failure', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([manifestTool('web_read', 'network_read', 'tool_call')])
    });
    const request = {
      toolCall: { id: 'call_web', name: 'web_read', args: { url: 'https://example.com' } },
      runtime: runtime('')
    };
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('web_read 请求失败：network reset'))
      .mockResolvedValueOnce(new ToolMessage({ tool_call_id: 'call_web', name: 'web_read', content: 'ok' }));

    await expect(middleware.wrapToolCall?.(request as never, handler as never)).rejects.toThrow(
      'web_read 请求失败：network reset'
    );
    const result = await middleware.wrapToolCall?.(request as never, handler as never);

    expect((result as ToolMessage).content).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('marks a manual-confirmation effect unknown and never retries it blindly', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([manifestTool('run_shell_command', 'host_execution', 'tool_call')])
    });
    const request = {
      toolCall: { id: 'call_shell', name: 'run_shell_command', args: { command: 'git status' } },
      runtime: runtime('')
    };
    const handler = vi.fn().mockRejectedValue(new Error('shell result unavailable'));

    await expect(middleware.wrapToolCall?.(request as never, handler as never)).rejects.toThrow(
      'shell result unavailable'
    );
    await expect(middleware.wrapToolCall?.(request as never, handler as never)).rejects.toThrow(
      'agent_tool_effect_unknown_manual_confirmation'
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('records a pre-effect tool resolution failure as final instead of unknown', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([manifestTool('schedule_background_task', 'external_call', 'tool_call')])
    });
    const request = {
      toolCall: {
        id: 'call_resolution',
        name: 'schedule_background_task',
        args: { previewId: 'missing-preview' }
      },
      runtime: runtime('')
    };
    const handler = vi.fn().mockRejectedValue(new RocToolResolutionError('preview missing'));

    await expect(middleware.wrapToolCall?.(request as never, handler as never)).rejects.toThrow('preview missing');

    expect(store.readState({
      runId: 'run_1',
      executionPath: 'main',
      checkpointId: 'checkpoint_main',
      toolCallId: 'call_resolution'
    })).toEqual({ status: 'failed_final' });
    await expect(middleware.wrapToolCall?.(request as never, handler as never)).rejects.toThrow(
      'agent_tool_effect_failed_final'
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('records a returned error ToolMessage as a final failure instead of a reusable success', async () => {
    const middleware = createToolEffectIdempotencyMiddleware({
      runId: 'run_1',
      threadId: 'thread_1',
      store,
      capabilityManifest: manifestFor([manifestTool('run_shell_command', 'host_execution', 'tool_call')])
    });
    const request = {
      toolCall: { id: 'call_error', name: 'run_shell_command', args: { command: 'git status' } },
      runtime: runtime('')
    };
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call_error',
      name: 'run_shell_command',
      content: 'shell command failed',
      status: 'error'
    }));

    const result = await middleware.wrapToolCall?.(request as never, handler as never);

    expect((result as ToolMessage).status).toBe('error');
    expect(
      db.prepare(
        `SELECT status
         FROM agent_tool_effects
         WHERE run_id = ? AND tool_call_id = ?`
      ).get('run_1', 'call_error')
    ).toEqual({ status: 'failed_final' });
    await expect(middleware.wrapToolCall?.(request as never, handler as never)).rejects.toThrow(
      'agent_tool_effect_failed_final'
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

function manifestFor(tools: RunCapabilityManifestV1['tools']): RunCapabilityManifestV1 {
  return {
    schemaVersion: 1,
    manifestHash: 'a'.repeat(64),
    requestedCapabilities: { mcpServers: [], skills: [] },
    resolvedCapabilities: { mcpServers: [], skills: [] },
    skippedCapabilities: [],
    tools,
    skills: [],
    untrustedContextPolicy: 'external_content_reference_only'
  };
}

function manifestTool(modelVisibleName: string, effectClass: RunCapabilityManifestV1['tools'][number]['effectClass'], idempotencyStrategy: 'none' | 'tool_call'): RunCapabilityManifestV1['tools'][number] {
  return {
    canonicalIdentity: `test:${modelVisibleName}`,
    modelVisibleName,
    provenance: { kind: 'mcp', serverId: 'server' },
    executionScopes: ['main', 'subagent'],
    riskLevel: effectClass === 'none' ? 'low' : 'medium',
    effectClass,
    approvalPolicy: { kind: 'none' },
    idempotencyStrategy,
    reconcileStrategy: effectClass === 'none' ? 'none' : effectClass === 'network_read' ? 'retry_safe' : 'manual_confirmation',
    resourceScope: 'external'
  };
}

function runtime(agentNamespace: string, checkpointId?: string) {
  const resolvedCheckpointId = checkpointId === undefined
    ? `checkpoint_${agentNamespace.length === 0 ? 'main' : agentNamespace}`
    : checkpointId;
  return {
    configurable: {
      ls_agent_type: agentNamespace.length === 0 ? 'root' : 'subagent',
      checkpoint_ns: agentNamespace.length === 0
        ? 'tools:current-tool-task'
        : `${agentNamespace}|tools:current-tool-task`,
      checkpoint_map: {
        [agentNamespace]: resolvedCheckpointId
      }
    }
  };
}
