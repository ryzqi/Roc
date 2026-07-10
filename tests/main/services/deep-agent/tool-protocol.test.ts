import { DynamicStructuredTool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BackgroundTaskPreview, BackgroundTaskPreviewRequest } from '../../../../src/shared/types';
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
    const middleware = createToolProtocolMiddleware();
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
});
