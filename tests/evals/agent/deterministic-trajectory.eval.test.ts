import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';

import { HumanMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { applyAgentPluginSchema } from '../../../src/main/plugins/agent/schema';
import { runWithLangSmithTracing } from '../../../src/main/services/deep-agent/langsmith-tracing';
import { RocSqliteCheckpointer } from '../../../src/main/services/deep-agent/sqlite-checkpointer';
import { defaultErrorTracker } from '../../../src/main/services/forge-guardrails';
import {
  assertTerminalOutcome,
  createEvalAgent,
  readFilePaths,
  readTodos,
  readTrajectory,
  todoItemSchema,
  trajectoryEventSchema
} from './eval-test-helpers';

const toolCallSchema = z
  .object({
    args: z.record(z.string(), z.unknown()),
    id: z.string().min(1),
    name: z.string().min(1)
  })
  .strict();

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
        const agent = createEvalAgent({
          mode: scenario.mode,
          model: new FakeToolCallingModel({ toolCalls: scenario.modelToolCalls }),
          checkpointer,
          systemPrompt: 'Use tools only when the request requires them.'
        });
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
