import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { InMemoryStore } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { compileRunCapabilityManifest } from '../../../src/main/plugins/agent/run-capability-manifest';
import { applyAgentPluginSchema } from '../../../src/main/plugins/agent/schema';
import { buildDeepAgent } from '../../../src/main/services/deep-agent/agent-builder';
import type { RocCompositeBackend } from '../../../src/main/services/deep-agent/backend';
import { runWithLangSmithTracing } from '../../../src/main/services/deep-agent/langsmith-tracing';
import { RocSqliteCheckpointer } from '../../../src/main/services/deep-agent/sqlite-checkpointer';
import { defaultErrorTracker } from '../../../src/main/services/forge-guardrails';

const todoItemSchema = z
  .object({
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed'])
  })
  .strict();

const toolCallSchema = z
  .object({
    args: z.record(z.string(), z.unknown()),
    id: z.string().min(1),
    name: z.string().min(1)
  })
  .strict();

const trajectoryEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      args: z.record(z.string(), z.unknown()),
      id: z.string().min(1),
      kind: z.literal('assistant_tool_call'),
      name: z.string().min(1)
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('tool_result'),
      name: z.string().min(1),
      status: z.enum(['success', 'error'])
    })
    .strict()
]);

const agentEvalCaseSchema = z
  .object({
    expected: z
      .object({
        files: z.array(z.string()),
        todos: z.array(todoItemSchema),
        trajectory: z.array(trajectoryEventSchema)
      })
      .strict(),
    id: z.string().regex(/^[a-z0-9_]+$/u),
    mode: z.enum(['chat', 'plan']),
    modelToolCalls: z.array(z.array(toolCallSchema)).min(1),
    prompt: z.string().min(1)
  })
  .strict();

const agentEvalDatasetSchema = z
  .object({
    cases: z.array(agentEvalCaseSchema).min(1),
    schemaVersion: z.literal(1)
  })
  .strict();

type AgentEvalCase = z.infer<typeof agentEvalCaseSchema>;
type TrajectoryEvent = z.infer<typeof trajectoryEventSchema>;

const dataset = await loadDataset();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('deterministic agent eval dataset contract', () => {
  it('rejects unknown dataset schema versions', () => {
    expect(() =>
      parseAgentEvalDataset({
        ...dataset,
        schemaVersion: 2
      })
    ).toThrow('agent_eval_dataset_invalid');
  });

  it('rejects duplicate case ids', () => {
    const firstCase = dataset.cases[0];
    if (firstCase === undefined) {
      throw new Error('agent_eval_dataset_case_missing');
    }

    expect(() =>
      parseAgentEvalDataset({
        schemaVersion: 1,
        cases: [firstCase, firstCase]
      })
    ).toThrow(`agent_eval_dataset_case_id_duplicate:${firstCase.id}`);
  });

  it('rejects unknown dataset fields', () => {
    expect(() =>
      parseAgentEvalDataset({
        ...dataset,
        unexpected: true
      })
    ).toThrow('agent_eval_dataset_invalid');
  });
});

describe('deterministic Roc agent trajectory evals', () => {
  it.each(dataset.cases)('$id', async (scenario) => {
    enableThenDisableAmbientLangSmithTracing();
    const unexpectedFetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        unexpectedFetches.push(String(input));
        throw new Error(`agent_eval_unexpected_fetch:${String(input)}`);
      })
    );
    const db = new Database(':memory:');
    const threadId = `thread_agent_eval_${scenario.id}`;

    try {
      applyAgentPluginSchema(db);
      const checkpointer = new RocSqliteCheckpointer(db);
      const result = await runWithLangSmithTracing(null, async () => {
        const agent = createEvalAgent(
          scenario,
          new FakeToolCallingModel({ toolCalls: scenario.modelToolCalls }),
          checkpointer
        );
        return await agent.invoke(
          {
            forge_error_tracker: defaultErrorTracker(),
            messages: [new HumanMessage(scenario.prompt)]
          },
          { configurable: { thread_id: threadId } }
        );
      });

      assertTerminalOutcome(result.messages);
      expect(readTrajectory(result.messages)).toEqual(scenario.expected.trajectory);
      expect(readTodos(result.todos)).toEqual(scenario.expected.todos);
      expect(readFilePaths(result.files)).toEqual(scenario.expected.files);

      const checkpoint = await checkpointer.get({ configurable: { thread_id: threadId } });
      if (checkpoint === undefined) {
        throw new Error(`agent_eval_checkpoint_missing:${scenario.id}`);
      }
      const persistedMessages = checkpoint.channel_values.messages;
      if (!Array.isArray(persistedMessages)) {
        throw new Error(`agent_eval_checkpoint_messages_missing:${scenario.id}`);
      }
      expect(readTrajectory(persistedMessages)).toEqual(scenario.expected.trajectory);
      expect(readTodos(checkpoint.channel_values.todos)).toEqual(scenario.expected.todos);
      expect(readFilePaths(checkpoint.channel_values.files)).toEqual(scenario.expected.files);
      expect(unexpectedFetches).toEqual([]);
    } finally {
      db.close();
    }
  });
});

async function loadDataset() {
  const content = await readFile(
    new URL('./datasets/deterministic-trajectory.v1.json', import.meta.url),
    'utf8'
  );
  const parsedJson: unknown = JSON.parse(content);
  return parseAgentEvalDataset(parsedJson);
}

function parseAgentEvalDataset(input: unknown) {
  const parsed = agentEvalDatasetSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('agent_eval_dataset_invalid', { cause: parsed.error });
  }
  const caseIds = new Set<string>();
  for (const scenario of parsed.data.cases) {
    if (caseIds.has(scenario.id)) {
      throw new Error(`agent_eval_dataset_case_id_duplicate:${scenario.id}`);
    }
    caseIds.add(scenario.id);
  }
  return parsed.data;
}

function createEvalAgent(
  scenario: AgentEvalCase,
  model: BaseChatModel,
  checkpointer: RocSqliteCheckpointer
) {
  const backend = Object.assign(new StateBackend(), { routePrefixes: [] }) as RocCompositeBackend;
  const capabilityManifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    requestedCapabilities: { mcpServers: [], skills: [] },
    skills: [],
    mode: scenario.mode,
    workflowHint: null
  }).manifest;

  return buildDeepAgent({
    mode: scenario.mode,
    model,
    systemPrompt: 'Use tools only when the request requires them.',
    backend,
    store: new InMemoryStore(),
    memorySources: [],
    skillSources: [],
    subagents: [],
    tools: [],
    capabilityManifest,
    filesystemPermissions: [],
    workspacePath: null,
    interruptOn: undefined,
    checkpointer,
    workflowHint: null,
    contextBudgetTokens: undefined,
    modelCallLimit: 6,
    modelThreadCallLimit: 6,
    toolCallLimit: 4,
    toolThreadCallLimit: 4
  });
}

function assertTerminalOutcome(messages: readonly BaseMessage[]): void {
  const terminalMessage = messages.at(-1);
  if (!AIMessage.isInstance(terminalMessage)) {
    throw new Error('agent_eval_terminal_ai_message_missing');
  }
  expect(readAiToolCalls(terminalMessage)).toEqual([]);
  if (typeof terminalMessage.content !== 'string') {
    throw new Error('agent_eval_terminal_content_not_text');
  }
  expect(terminalMessage.content.length).toBeGreaterThan(0);
}

function readTrajectory(messages: readonly BaseMessage[]): TrajectoryEvent[] {
  const trajectory: TrajectoryEvent[] = [];
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const toolCall of readAiToolCalls(message)) {
        trajectory.push({
          args: toolCall.args,
          id: requireToolCallId(toolCall.id),
          kind: 'assistant_tool_call',
          name: toolCall.name
        });
      }
    }
    if (ToolMessage.isInstance(message)) {
      if (message.name === undefined || message.name.length === 0) {
        throw new Error('agent_eval_tool_result_name_missing');
      }
      trajectory.push({
        id: message.tool_call_id,
        kind: 'tool_result',
        name: message.name,
        status: readToolResultStatus(message.status)
      });
    }
  }
  return trajectory;
}

function readAiToolCalls(message: AIMessage) {
  if (message.tool_calls === undefined) {
    return [];
  }
  return message.tool_calls;
}

function requireToolCallId(id: string | undefined): string {
  if (id === undefined || id.length === 0) {
    throw new Error('agent_eval_tool_call_id_missing');
  }
  return id;
}

function readToolResultStatus(status: ToolMessage['status']): 'success' | 'error' {
  // LangChain 1.2.x omits status for successful tool results; errors are explicit.
  if (status === undefined || status === 'success') {
    return 'success';
  }
  if (status === 'error') {
    return 'error';
  }
  throw new Error('agent_eval_tool_result_status_invalid');
}

function readTodos(value: unknown) {
  if (value === undefined) {
    return [];
  }
  const parsed = z.array(todoItemSchema).safeParse(value);
  if (!parsed.success) {
    throw new Error('agent_eval_todos_invalid', { cause: parsed.error });
  }
  return parsed.data;
}

function readFilePaths(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent_eval_files_invalid');
  }
  return Object.keys(value).sort();
}

function enableThenDisableAmbientLangSmithTracing(): void {
  vi.stubEnv('LANGSMITH_TRACING_V2', 'true');
  vi.stubEnv('LANGCHAIN_TRACING_V2', 'true');
  vi.stubEnv('LANGSMITH_TRACING', 'true');
  vi.stubEnv('LANGCHAIN_TRACING', 'true');
  vi.stubEnv('LANGSMITH_API_KEY', 'ambient-langsmith-key');
  vi.stubEnv('LANGCHAIN_API_KEY', 'ambient-langchain-key');
  vi.stubEnv('LANGSMITH_TRACING_V2', 'false');
  vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
  vi.stubEnv('LANGSMITH_TRACING', 'false');
  vi.stubEnv('LANGCHAIN_TRACING', 'false');
  vi.stubEnv('LANGSMITH_API_KEY', '');
  vi.stubEnv('LANGCHAIN_API_KEY', '');
}
