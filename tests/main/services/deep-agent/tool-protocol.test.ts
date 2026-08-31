import { ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  RunCapabilityExecutionScopeV1,
  RunCapabilityManifestToolV1,
  RunCapabilityManifestV1
} from '../../../../src/shared/types';
import { createToolProtocolMiddleware, normalizeToolCallArgs } from '../../../../src/main/services/deep-agent/tool-protocol';
import { createBackgroundTaskTools, proposeToolInputSchema } from '../../../../src/main/services/deep-agent/background-task-tools';
import { PreviewStore } from '../../../../src/main/services/forge-guardrails';

describe('deep agent tool protocol', () => {
  it('keeps background task tool schemas pure JSON Schema without preprocess transforms', () => {
    const tools = createBackgroundTaskTools({
      previewStore: new PreviewStore(),
      runtimeWorkspacePath: process.cwd(),
      taskAdapter: {
        createBackgroundTaskPreview: async (request) =>
          ({
            ...request,
            scheduled: false,
            nextRunAt: null,
            cronExpression: null,
            riskLevel: 'low',
            requiresConfirmation: false,
            enabledCapabilities: null
          }) satisfies BackgroundTaskPreview,
        createBackgroundTask: async () => ({ id: 'task-1', threadId: 'thread-1', nextRunAt: null }),
        readBackgroundTask: async () => {
          throw new Error('unexpected_read');
        },
        updateBackgroundTask: async () => ({ id: 'task-1', threadId: 'thread-1', nextRunAt: null }),
        cancelBackgroundTask: async () => ({ id: 'task-1', threadId: 'thread-1', status: 'cancelled' })
      },
      schedulerAdapter: {
        refreshTask: () => {},
        registerTask: () => {},
        unregisterTask: () => {}
      }
    });

    expect(proposeToolInputSchema.shape.trigger).toBeTypeOf('object');
    expect(proposeToolInputSchema.shape.trigger.constructor.name).not.toBe('ZodPipe');
    expect(tools.map((tool) => Reflect.get(tool, 'schema')).map((schema) => schema?.constructor.name)).not.toContain('ZodPipe');
  });

  it('preserves the raw request through preview and schedule without overriding main-derived fields', async () => {
    const createBackgroundTask = vi.fn(async (_request: BackgroundTaskPreviewRequest) => ({
      id: 'task-1',
      threadId: 'thread-1',
      nextRunAt: null
    }));
    const tools = createBackgroundTaskTools({
      previewStore: new PreviewStore(),
      runtimeWorkspacePath: process.cwd(),
      taskAdapter: {
        createBackgroundTaskPreview: async (request) => ({
          ...request,
          scheduled: false,
          nextRunAt: null,
          cronExpression: null,
          riskLevel: 'medium',
          requiresConfirmation: true,
          enabledCapabilities: null
        }),
        createBackgroundTask,
        readBackgroundTask: async () => {
          throw new Error('unexpected_read');
        },
        updateBackgroundTask: async () => ({ id: 'task-1', threadId: 'thread-1', nextRunAt: null }),
        cancelBackgroundTask: async () => ({ id: 'task-1', threadId: 'thread-1', status: 'cancelled' })
      },
      schedulerAdapter: {
        refreshTask: () => {},
        registerTask: () => {},
        unregisterTask: () => {}
      }
    });
    const proposeTool = tools.find((tool) => tool.name === 'propose_background_task');
    const scheduleTool = tools.find((tool) => tool.name === 'schedule_background_task');
    if (proposeTool === undefined || scheduleTool === undefined) {
      throw new Error('background_task_tools_missing');
    }

    const proposed = JSON.parse(
      await proposeTool.invoke({
        goal: '检查测试',
        trigger: {
          type: 'manual',
          description: '手动'
        }
      })
    ) as { previewId: string; preview: BackgroundTaskPreview };
    await scheduleTool.invoke({ previewId: proposed.previewId });

    expect(proposed.preview).toMatchObject({
      riskLevel: 'medium',
      requiresConfirmation: true
    });
    expect(createBackgroundTask).toHaveBeenCalledWith({
      goal: '检查测试',
      trigger: {
        type: 'manual',
        description: '手动'
      },
      workspacePath: process.cwd(),
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      enabledCapabilities: null
    });
  });

  it('normalizes stringified tool handoff in the protocol layer before schema parsing', async () => {
    const normalized = normalizeToolCallArgs('propose_background_task', {
      goal: '每天检查测试',
      trigger: JSON.stringify({
        type: 'manual',
        description: '手动'
      }),
      workspacePath: 'F:\\Code\\Roc'
    });

    expect(normalized).toEqual({
      goal: '每天检查测试',
      trigger: {
        type: 'manual',
        description: '手动'
      },
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(proposeToolInputSchema.parse(normalized).trigger).toEqual({
      type: 'manual',
      description: '手动'
    });
  });

  it('wraps tool calls so createDeepAgent can bind JSON-Schema-only tools without schema transforms', async () => {
    const schema = z.strictObject({
      trigger: z.strictObject({
        type: z.literal('manual'),
        description: z.string()
      })
    });
    const tool = new DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string>({
      name: 'propose_background_task',
      description: 'Create a background task preview.',
      schema,
      func: async (input) => input.trigger.description
    });
    const middleware = createToolProtocolMiddleware({
      capabilityManifest: createCapabilityManifest([
        createManifestTool('propose_background_task', ['main'])
      ]),
      executionScope: 'main',
      boundToolNames: ['propose_background_task']
    });
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected tool protocol middleware to expose wrapToolCall.');
    }
    const handler = vi.fn(async (request: { toolCall: { args: unknown } }) => {
      const parsed = schema.parse(request.toolCall.args);
      return await tool.invoke(parsed);
    });

    const result = await middleware.wrapToolCall(
      {
        tool,
        toolCall: {
          name: 'propose_background_task',
          args: {
            trigger: '{"type":"manual","description":"手动"}'
          },
          id: 'call-propose'
        }
      } as never,
      handler as never
    );

    expect(result).toBe('手动');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({
          args: {
            trigger: {
              type: 'manual',
              description: '手动'
            }
          }
        })
      })
    );
  });

  it('rejects unregistered, out-of-scope, and identity-drift tool calls before invoking their handlers', async () => {
    const webReadTool = createNamedTool('web_read');
    const shellTool = createNamedTool('run_shell_command');
    const scheduleTool = createNamedTool('schedule_background_task');
    const handler = vi.fn(async () => 'unexpected_handler_call');
    const mainManifest = createCapabilityManifest([
      createManifestTool('web_read', ['main'])
    ]);
    const boundToolNames = ['web_read', 'run_shell_command', 'schedule_background_task'];
    const mainMiddleware = createToolProtocolMiddleware({
      capabilityManifest: mainManifest,
      executionScope: 'main',
      boundToolNames
    });
    const subagentMiddleware = createToolProtocolMiddleware({
      capabilityManifest: mainManifest,
      executionScope: 'subagent',
      boundToolNames
    });
    const backgroundSubagentMiddleware = createToolProtocolMiddleware({
      capabilityManifest: createCapabilityManifest([
        createManifestTool('schedule_background_task', ['main'])
      ]),
      executionScope: 'subagent',
      boundToolNames
    });

    await expect(mainMiddleware.wrapToolCall?.({
      tool: shellTool,
      toolCall: { name: 'run_shell_command', args: {}, id: 'call-unregistered' }
    } as never, handler as never)).rejects.toThrow('agent_capability_manifest_tool_not_authorized:run_shell_command');
    await expect(mainMiddleware.wrapToolCall?.({
      tool: scheduleTool,
      toolCall: { name: 'schedule_background_task', args: {}, id: 'call-runtime-unregistered' }
    } as never, handler as never)).rejects.toThrow('agent_capability_manifest_tool_not_authorized:schedule_background_task');
    await expect(subagentMiddleware.wrapToolCall?.({
      tool: webReadTool,
      toolCall: { name: 'web_read', args: {}, id: 'call-out-of-scope' }
    } as never, handler as never)).rejects.toThrow('agent_capability_manifest_scope_denied:web_read:subagent');
    await expect(mainMiddleware.wrapToolCall?.({
      tool: shellTool,
      toolCall: { name: 'web_read', args: {}, id: 'call-identity-drift' }
    } as never, handler as never)).rejects.toThrow('agent_capability_manifest_tool_identity_mismatch:web_read');
    await expect(backgroundSubagentMiddleware.wrapToolCall?.({
      tool: scheduleTool,
      toolCall: { name: 'schedule_background_task', args: {}, id: 'call-background-scope' }
    } as never, handler as never)).rejects.toThrow('agent_capability_manifest_scope_denied:schedule_background_task:subagent');

    expect(handler).not.toHaveBeenCalled();
  });

  it('softens an unbound tool name but keeps a bound one fatal when the request omits the tool field', async () => {
    const handler = vi.fn(async () => 'unexpected_handler_call');
    const middleware = createToolProtocolMiddleware({
      capabilityManifest: createCapabilityManifest([createManifestTool('write_file', ['main'])]),
      executionScope: 'main',
      boundToolNames: ['write_file', 'delete_file']
    });
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected tool protocol middleware to expose wrapToolCall.');
    }

    // 名字既无 tool 字段又不在绑定集合里：模型幻觉，软化为可自纠的 error ToolMessage。
    const hallucinated = await middleware.wrapToolCall(
      { toolCall: { name: 'write', args: {}, id: 'call-hallucinated' } } as never,
      handler as never
    );

    expect(ToolMessage.isInstance(hallucinated)).toBe(true);
    if (!ToolMessage.isInstance(hallucinated)) {
      throw new Error('Expected a ToolMessage for the hallucinated tool name.');
    }
    expect(hallucinated.status).toBe('error');
    expect(hallucinated.tool_call_id).toBe('call-hallucinated');
    expect(hallucinated.content).toBe('write is not an available tool. Available tools: write_file.');

    // 已绑定但未授权：即使 tool 字段被上游中间件丢掉，仍必须硬失败。
    await expect(middleware.wrapToolCall(
      { toolCall: { name: 'delete_file', args: {}, id: 'call-bound-unauthorized' } } as never,
      handler as never
    )).rejects.toThrow('agent_capability_manifest_tool_not_authorized:delete_file');

    expect(handler).not.toHaveBeenCalled();
  });
});

function createCapabilityManifest(tools: RunCapabilityManifestToolV1[] = []): RunCapabilityManifestV1 {
  return {
    schemaVersion: 1,
    manifestHash: 'manifest-hash',
    requestedCapabilities: { mcpServers: [], skills: [] },
    resolvedCapabilities: { mcpServers: [], skills: [] },
    skippedCapabilities: [],
    tools,
    skills: [],
    untrustedContextPolicy: 'external_content_reference_only'
  };
}

function createManifestTool(
  modelVisibleName: string,
  executionScopes: RunCapabilityExecutionScopeV1[]
): RunCapabilityManifestToolV1 {
  return {
    canonicalIdentity: `builtin:${modelVisibleName}`,
    modelVisibleName,
    provenance: { kind: 'builtin', source: 'roc' },
    executionScopes,
    riskLevel: 'medium',
    effectClass: 'network_read',
    approvalPolicy: { kind: 'none' },
    idempotencyStrategy: 'none',
    resourceScope: 'network'
  };
}

function createNamedTool(name: string) {
  return new DynamicStructuredTool({
    name,
    description: `${name} tool`,
    schema: z.object({}),
    func: async () => ''
  });
}
