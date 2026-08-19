import Database from 'better-sqlite3';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { InMemoryStore } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileRunCapabilityManifest } from '../../../src/main/plugins/agent/run-capability-manifest';
import { applyAgentDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';
import { buildDeepAgent } from '../../../src/main/services/deep-agent/agent-builder';
import type { RocCompositeBackend } from '../../../src/main/services/deep-agent/backend';
import { runWithLangSmithTracing } from '../../../src/main/services/deep-agent/langsmith-tracing';
import { RocSqliteCheckpointer } from '../../../src/main/services/deep-agent/sqlite-checkpointer';
import { defaultErrorTracker } from '../../../src/main/services/forge-guardrails';

const offlineThreadId = 'thread_agent_integration_offline';
const offlineTodos = [{ content: 'Verify the native agent integration path.', status: 'completed' }];
const offlineTrajectory = [
  {
    kind: 'assistant_tool_call',
    name: 'write_todos',
    id: 'call_agent_integration_todo',
    args: { todos: offlineTodos }
  },
  {
    kind: 'tool_result',
    name: 'write_todos',
    id: 'call_agent_integration_todo'
  }
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Roc Deep Agent offline integration', () => {
  it('executes native write_todos and persists the trajectory in Roc SQLite', async () => {
    vi.stubEnv('LANGSMITH_TRACING_V2', 'true');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'true');
    vi.stubEnv('LANGSMITH_TRACING', 'true');
    vi.stubEnv('LANGCHAIN_TRACING', 'true');
    vi.stubEnv('LANGSMITH_API_KEY', 'ambient-langsmith-key');
    vi.stubEnv('LANGCHAIN_API_KEY', 'ambient-langchain-key');
    disableAmbientLangSmithTracing();
    const unexpectedFetches: Array<{ url: string; stack: string }> = [];
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const stack = new Error('agent_integration_unexpected_fetch').stack;
      unexpectedFetches.push({
        url: String(input),
        stack: stack === undefined ? 'stack_unavailable' : stack
      });
      throw new Error(`agent_integration_unexpected_fetch:${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    const db = new Database(':memory:');

    try {
      applyAgentDatabaseSchema(db);
      const checkpointer = new RocSqliteCheckpointer(db);
      const result = await runWithLangSmithTracing(null, async () => {
        const agent = createIntegrationAgent(
          new FakeToolCallingModel({
            toolCalls: [
              [
                {
                  name: 'write_todos',
                  args: { todos: offlineTodos },
                  id: 'call_agent_integration_todo'
                }
              ],
              []
            ]
          }),
          checkpointer
        );
        return await agent.invoke(
          {
            forge_error_tracker: defaultErrorTracker(),
            messages: [new HumanMessage('Record the completed integration verification step.')]
          },
          { configurable: { thread_id: offlineThreadId } }
        );
      });

      expect(result.todos).toEqual(offlineTodos);
      expect(readTrajectory(result.messages)).toEqual(offlineTrajectory);
      const terminalMessage = requireTerminalAiMessage(result.messages);
      expect(readAiToolCalls(terminalMessage)).toEqual([]);
      if (typeof terminalMessage.content !== 'string') {
        throw new Error('agent_integration_terminal_content_not_text');
      }
      expect(terminalMessage.content.length).toBeGreaterThan(0);

      const checkpoint = await checkpointer.get({ configurable: { thread_id: offlineThreadId } });
      if (checkpoint === undefined) {
        throw new Error('agent_integration_checkpoint_missing');
      }
      expect(checkpoint.channel_values.todos).toEqual(offlineTodos);
      const persistedMessages = checkpoint.channel_values.messages;
      if (!Array.isArray(persistedMessages)) {
        throw new Error('agent_integration_checkpoint_messages_missing');
      }
      expect(readTrajectory(persistedMessages)).toEqual(offlineTrajectory);
      expect(readCheckpointCount(db, offlineThreadId)).toBeGreaterThan(0);
      expect(unexpectedFetches).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(process.env.ROC_AGENT_INTEGRATION_LIVE !== '1')('Roc Deep Agent live provider integration', () => {
  it('runs a terminal Anthropic turn through the Roc builder and checkpointer', async () => {
    const apiKey = requireLiveAnthropicApiKey();
    disableAmbientLangSmithTracing();
    const db = new Database(':memory:');
    const threadId = 'thread_agent_integration_live_anthropic';

    try {
      applyAgentDatabaseSchema(db);
      const checkpointer = new RocSqliteCheckpointer(db);
      const result = await runWithLangSmithTracing(null, async () => {
        const agent = createIntegrationAgent(
          new ChatAnthropic({
            apiKey,
            clientOptions: { timeout: 45_000 },
            maxRetries: 0,
            maxTokens: 128,
            model: 'claude-haiku-4-5-20251001',
            temperature: 0
          }),
          checkpointer
        );
        return await agent.invoke(
          {
            forge_error_tracker: defaultErrorTracker(),
            messages: [new HumanMessage('Reply directly with a short integration acknowledgement.')]
          },
          {
            configurable: { thread_id: threadId },
            signal: AbortSignal.timeout(45_000)
          }
        );
      });

      const terminalMessage = requireTerminalAiMessage(result.messages);
      expect(readAiToolCalls(terminalMessage)).toEqual([]);
      const checkpoint = await checkpointer.get({ configurable: { thread_id: threadId } });
      if (checkpoint === undefined) {
        throw new Error('agent_integration_live_checkpoint_missing');
      }
      const persistedMessages = checkpoint.channel_values.messages;
      if (!Array.isArray(persistedMessages)) {
        throw new Error('agent_integration_live_checkpoint_messages_missing');
      }
      requireTerminalAiMessage(persistedMessages);
      expect(readCheckpointCount(db, threadId)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

function createIntegrationAgent(model: BaseChatModel, checkpointer: RocSqliteCheckpointer) {
  const backend = Object.assign(new StateBackend(), { routePrefixes: [] }) as RocCompositeBackend;
  const capabilityManifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    requestedCapabilities: { mcpServers: [], skills: [] },
    skills: [],
    mode: 'chat',
    workflowHint: null
  }).manifest;

  return buildDeepAgent({
    mode: 'run',
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

function readTrajectory(messages: readonly BaseMessage[]) {
  const trajectory: Array<
    | { kind: 'assistant_tool_call'; name: string; id: string | undefined; args: Record<string, unknown> }
    | { kind: 'tool_result'; name: string | undefined; id: string }
  > = [];
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const toolCall of readAiToolCalls(message)) {
        trajectory.push({
          kind: 'assistant_tool_call',
          name: toolCall.name,
          id: toolCall.id,
          args: toolCall.args
        });
      }
    }
    if (ToolMessage.isInstance(message)) {
      trajectory.push({
        kind: 'tool_result',
        name: message.name,
        id: message.tool_call_id
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

function requireTerminalAiMessage(messages: readonly BaseMessage[]): AIMessage {
  const message = messages.at(-1);
  if (!AIMessage.isInstance(message)) {
    throw new Error('agent_integration_terminal_ai_message_missing');
  }
  return message;
}

function requireLiveAnthropicApiKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error('agent_integration_anthropic_api_key_missing');
  }
  return apiKey;
}

function disableAmbientLangSmithTracing(): void {
  vi.stubEnv('LANGSMITH_TRACING_V2', 'false');
  vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
  vi.stubEnv('LANGSMITH_TRACING', 'false');
  vi.stubEnv('LANGCHAIN_TRACING', 'false');
  vi.stubEnv('LANGSMITH_API_KEY', '');
  vi.stubEnv('LANGCHAIN_API_KEY', '');
}

function readCheckpointCount(db: Database.Database, threadId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM langgraph_checkpoints WHERE thread_id = ?')
    .get(threadId) as { count: number };
  return row.count;
}
