import Database from 'better-sqlite3';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, InMemoryStore, isCommand } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { FakeToolCallingModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { buildDeepAgent, type DeepAgentBuildInput } from '../../../../src/main/services/deep-agent/agent-builder';
import type { RocCompositeBackend } from '../../../../src/main/services/deep-agent/backend';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';
import {
  createRocSubagentBudgetStateInitializationMiddleware,
  createRocSubagentStateIsolationMiddleware
} from '../../../../src/main/services/deep-agent/subagent-state-isolation';
import { defaultErrorTracker } from '../../../../src/main/services/forge-guardrails';

describe('subagent budget state isolation', () => {
  it('removes only native budget state from task commands and preserves routing fields', async () => {
    const middleware = createRocSubagentStateIsolationMiddleware();
    const wrapToolCall = middleware.wrapToolCall;
    if (wrapToolCall === undefined) {
      throw new Error('subagent_state_isolation_wrap_missing');
    }
    const original = new Command({
      graph: Command.PARENT,
      goto: ['continue'],
      resume: { approved: true },
      update: {
        branchEvidence: 'preserved',
        messages: ['task-result'],
        runModelCallCount: 0,
        runToolCallCount: {},
        threadModelCallCount: 2,
        threadToolCallCount: { __all__: 1 }
      }
    });
    const result = await wrapToolCall(
      {
        state: {},
        toolCall: {
          args: {},
          id: 'call_task_isolation',
          name: 'task',
          type: 'tool_call'
        }
      } as never,
      async () => original
    );

    expect(isCommand(result)).toBe(true);
    if (!isCommand(result)) {
      throw new Error('subagent_state_isolation_result_not_command');
    }
    expect(result.update).toEqual({
      branchEvidence: 'preserved',
      messages: ['task-result']
    });
    expect(result.graph).toBe(Command.PARENT);
    expect(result.goto).toEqual(['continue']);
    expect(result.resume).toEqual({ approved: true });
    expect(original.update).toHaveProperty('threadModelCallCount', 2);
  });

  it('initializes each delegated subagent with independent native budget state', async () => {
    const middleware = createRocSubagentBudgetStateInitializationMiddleware();
    const beforeAgent = middleware.beforeAgent;
    if (typeof beforeAgent !== 'function') {
      throw new Error('subagent_budget_initialization_hook_missing');
    }

    expect(beforeAgent({} as never, {} as never)).toEqual({
      runModelCallCount: 0,
      runToolCallCount: {},
      threadModelCallCount: 0,
      threadToolCallCount: {}
    });
  });

  it('completes three concurrent task branches without merging their native counters into parent state', async () => {
    const db = new Database(':memory:');
    try {
      applyAgentPluginSchema(db);
      const subagentNames = ['budget-a', 'budget-b', 'budget-c'] as const;
      const taskCallIds = subagentNames.map((name) => `call_${name}`);
      const subagentModels = subagentNames.map(() =>
        new FakeToolCallingModel({ toolCalls: [[], []] })
      );
      const mainModel = new FakeToolCallingModel({
        toolCalls: [
          subagentNames.map((name, index) => ({
            args: {
              description: `Complete deterministic branch ${index}.`,
              subagent_type: name
            },
            id: taskCallIds[index],
            name: 'task'
          })),
          []
        ]
      });
      const subagents: DeepAgentBuildInput['subagents'] = subagentNames.map((name, index) => ({
        description: `Budget isolation fixture ${index}.`,
        model: subagentModels[index],
        name,
        systemPrompt: 'Return the deterministic branch result.',
        tools: []
      }));
      const capabilityManifest = compileRunCapabilityManifest({
        deleteFileApprovalMode: 'fully_automatic',
        mcpApprovalMode: 'fully_automatic',
        mcpServers: [],
        requestedCapabilities: { mcpServers: [], skills: [] },
        skills: [],
        mode: 'chat',
        workflowHint: null
      }).manifest;
      const backend = Object.assign(new StateBackend(), { routePrefixes: [] }) as RocCompositeBackend;
      const agent = buildDeepAgent({
        backend,
        capabilityManifest,
        checkpointer: new RocSqliteCheckpointer(db),
        contextBudgetTokens: undefined,
        filesystemPermissions: [],
        interruptOn: undefined,
        memorySources: [],
        mode: 'run',
        model: mainModel,
        modelCallLimit: 10,
        modelThreadCallLimit: 100,
        skillSources: [],
        store: new InMemoryStore(),
        subagents,
        systemPrompt: 'Delegate all three branches in one model turn.',
        toolCallLimit: 10,
        toolThreadCallLimit: 100,
        tools: [],
        workflowHint: null,
        workspacePath: null
      });

      const result = await agent.invoke(
        {
          forge_error_tracker: defaultErrorTracker(),
          messages: [new HumanMessage('Run all deterministic branches.')]
        },
        {
          configurable: { thread_id: 'thread_subagent_budget_isolation' },
          recursionLimit: 60
        }
      );

      expect(subagentModels.map((model) => model.index)).toEqual([1, 1, 1]);
      expect(result.messages.some((message: BaseMessage) =>
        AIMessage.isInstance(message) && message.tool_calls?.length === 3
      )).toBe(true);
      expect(result.messages
        .filter((message: BaseMessage) =>
          ToolMessage.isInstance(message) && taskCallIds.includes(message.tool_call_id)
        )
        .map((message: BaseMessage) => (message as ToolMessage).tool_call_id)
        .sort()).toEqual([...taskCallIds].sort());
    } finally {
      db.close();
    }
  });

  it('gives a delegated subagent its own native model budget and blocks the third call', async () => {
    const db = new Database(':memory:');
    try {
      applyAgentPluginSchema(db);
      const subagentModel = new FakeToolCallingModel({
        toolCalls: [
          [
            {
              args: {
                todos: [{ content: 'Attempt another model turn.', status: 'in_progress' }]
              },
              id: 'call_budget_todo',
              name: 'write_todos'
            }
          ],
          [
            {
              args: {
                todos: [{ content: 'Attempt the final model turn.', status: 'in_progress' }]
              },
              id: 'call_budget_todo_second',
              name: 'write_todos'
            }
          ],
          []
        ]
      });
      const mainModel = new FakeToolCallingModel({
        toolCalls: [
          [
            {
              args: {
                description: 'Use two model turns.',
                subagent_type: 'budget-limited'
              },
              id: 'call_budget_limited',
              name: 'task'
            }
          ],
          []
        ]
      });
      const agent = createAgentFixture(db, mainModel, [
        {
          description: 'Native budget behavior fixture.',
          model: subagentModel,
          name: 'budget-limited',
          systemPrompt: 'Update the todo list, then answer.',
          tools: []
        }
      ], {
        modelCallLimit: 2,
        modelThreadCallLimit: 100,
        toolCallLimit: 10,
        toolThreadCallLimit: 100
      });

      const result = await agent.invoke(
        {
          forge_error_tracker: defaultErrorTracker(),
          messages: [new HumanMessage('Delegate the bounded branch.')]
        },
        {
          configurable: { thread_id: 'thread_subagent_budget_limit' },
          recursionLimit: 60
        }
      );

      expect(subagentModel.index).toBe(2);
      const taskResult = result.messages.find((message: BaseMessage) =>
        ToolMessage.isInstance(message) && message.tool_call_id === 'call_budget_limited'
      );
      expect(taskResult).toBeInstanceOf(ToolMessage);
      expect((taskResult as ToolMessage).status).toBe('error');
      expect((taskResult as ToolMessage).content).toContain('Model call limits exceeded');
    } finally {
      db.close();
    }
  });

  it('gives a delegated subagent its own native tool budget and rejects an oversized batch', async () => {
    const db = new Database(':memory:');
    try {
      applyAgentPluginSchema(db);
      const subagentModel = new FakeToolCallingModel({
        toolCalls: [
          [0, 1, 2].map((index) => ({
            args: {
              todos: [{ content: `Attempt tool call ${index}.`, status: 'in_progress' }]
            },
            id: `call_tool_budget_todo_${index}`,
            name: 'write_todos'
          })),
          []
        ]
      });
      const mainModel = new FakeToolCallingModel({
        toolCalls: [
          [
            {
              args: {
                description: 'Attempt an oversized tool batch.',
                subagent_type: 'tool-budget-limited'
              },
              id: 'call_tool_budget_limited',
              name: 'task'
            }
          ],
          []
        ]
      });
      const agent = createAgentFixture(db, mainModel, [
        {
          description: 'Native tool budget behavior fixture.',
          model: subagentModel,
          name: 'tool-budget-limited',
          systemPrompt: 'Update the todo list, then answer.',
          tools: []
        }
      ], {
        modelCallLimit: 10,
        modelThreadCallLimit: 100,
        toolCallLimit: 2,
        toolThreadCallLimit: 100
      });

      const result = await agent.invoke(
        {
          forge_error_tracker: defaultErrorTracker(),
          messages: [new HumanMessage('Delegate the oversized tool batch.')]
        },
        {
          configurable: { thread_id: 'thread_subagent_tool_budget_limit' },
          recursionLimit: 60
        }
      );

      const taskResult = result.messages.find((message: BaseMessage) =>
        ToolMessage.isInstance(message) && message.tool_call_id === 'call_tool_budget_limited'
      );
      expect(taskResult).toBeInstanceOf(ToolMessage);
      expect((taskResult as ToolMessage).status).toBe('error');
      expect((taskResult as ToolMessage).content).toContain('Tool call limit reached');
      expect(subagentModel.index).toBe(1);
      expect(Reflect.get(result, 'threadToolCallCount')).toEqual({ __all__: 1 });
    } finally {
      db.close();
    }
  });

});

function createAgentFixture(
  db: Database.Database,
  model: FakeToolCallingModel,
  subagents: DeepAgentBuildInput['subagents'],
  limits: {
    modelCallLimit: number;
    modelThreadCallLimit: number;
    toolCallLimit: number;
    toolThreadCallLimit: number;
  } = {
    modelCallLimit: 10,
    modelThreadCallLimit: 100,
    toolCallLimit: 10,
    toolThreadCallLimit: 100
  }
) {
  const capabilityManifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    requestedCapabilities: { mcpServers: [], skills: [] },
    skills: [],
    mode: 'chat',
    workflowHint: null
  }).manifest;
  const backend = Object.assign(new StateBackend(), { routePrefixes: [] }) as RocCompositeBackend;
  return buildDeepAgent({
    backend,
    capabilityManifest,
    checkpointer: new RocSqliteCheckpointer(db),
    contextBudgetTokens: undefined,
    filesystemPermissions: [],
    interruptOn: undefined,
    memorySources: [],
    mode: 'run',
    model,
    modelCallLimit: limits.modelCallLimit,
    modelThreadCallLimit: limits.modelThreadCallLimit,
    skillSources: [],
    store: new InMemoryStore(),
    subagents,
    systemPrompt: 'Delegate the requested deterministic branches.',
    toolCallLimit: limits.toolCallLimit,
    toolThreadCallLimit: limits.toolThreadCallLimit,
    tools: [],
    workflowHint: null,
    workspacePath: null
  });
}
