import Database from 'better-sqlite3';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { countTokensApproximately } from 'langchain';
import { createDeepAgent, createSummarizationMiddleware, getHarnessProfile } from 'deepagents';
import { describe, expect, it, vi } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../../src/main/infrastructure/database-schemas';
import { compileRunCapabilityManifest } from '../../../../../src/main/plugins/agent/run-capability-manifest';
import { buildDeepAgent } from '../../../../../src/main/services/deep-agent/agent-builder';
import { ContextArtifactStore } from '../../../../../src/main/services/deep-agent/context/context-artifact-store';
import { runContextCompactionForTest } from '../../../../../src/main/services/deep-agent/context/context-compaction-pipeline';
import { ensureRocHarnessProfilesRegistered } from '../../../../../src/main/services/deep-agent/harness-profiles';
import { markIterationOnMessage } from '../../../../../src/main/services/forge-guardrails';
import { RocSqliteCheckpointer } from '../../../../../src/main/services/deep-agent/sqlite-checkpointer';
import {
  createDeepAgentTestSnapshot,
  getSubagentMiddleware,
  isBuiltSubagent
} from '../../../deep-agent-test-helpers';

vi.mock('deepagents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('deepagents')>();
  return { ...actual, createDeepAgent: vi.fn(() => ({ __stubAgent: true })) };
});

const FIDELITY_MARKERS = ['PROJECT=Atlas', 'DECISION=SQLite', 'NEXT=verification'] as const;

describe('Deep Agents native summarization conformance', () => {
  it('compares native and Roc compaction on a fixed long-context corpus', async () => {
    const nativeMessages = createFixedCorpus();
    const nativeAuditEvents: string[] = [];
    const nativeWrites = new Map<string, string>();
    const nativeDelivered: BaseMessage[][] = [];
    const nativeSummaryInputs: BaseMessage[][] = [];
    const nativeSummaryOutputs: string[] = [];
    const nativeModel = {
      profile: { maxInputTokens: 1200 },
      invoke: vi.fn(async (messages: readonly BaseMessage[]) => {
        const source = messageText(messages);
        nativeSummaryInputs.push([...messages]);
        const summary = FIDELITY_MARKERS.filter((marker) => source.includes(marker)).join('; ');
        nativeSummaryOutputs.push(summary);
        return new AIMessage({ content: summary });
      })
    };
    const nativeMiddleware = createSummarizationMiddleware({
      backend: {
        write: async (path: string, content: string) => {
          nativeWrites.set(path, content);
          return { path };
        }
      } as never,
      trigger: { type: 'messages', value: 4 },
      keep: { type: 'messages', value: 2 },
      truncateArgsSettings: {
        trigger: { type: 'messages', value: 100 },
        keep: { type: 'messages', value: 100 }
      }
    });
    if (typeof nativeMiddleware.wrapModelCall !== 'function') {
      throw new Error('native_summarization_wrap_model_call_missing');
    }
    nativeAuditEvents.push('context_summary_started');
    const nativeResult = await nativeMiddleware.wrapModelCall(
      {
        messages: nativeMessages,
        model: nativeModel,
        runtime: {},
        state: {},
        systemMessage: new SystemMessage({ content: 'Roc conformance system prompt.' }),
        tools: []
      } as never,
      async (request) => {
        nativeDelivered.push([...request.messages]);
        return new AIMessage({ content: 'native completed' });
      }
    );
    nativeAuditEvents.push('context_summary_completed');
    const nativeUpdate = Reflect.get(nativeResult as object, 'update');
    if (nativeUpdate === null || typeof nativeUpdate !== 'object') {
      throw new Error('native_summarization_state_update_missing');
    }
    const deliveredByNative = nativeDelivered[0];
    if (deliveredByNative === undefined) {
      throw new Error('native_summarization_handler_not_called');
    }

    const db = new Database(':memory:');
    try {
      applyAgentDatabaseSchema(db);
      seedThread(db, 'thread_native_conformance');
      const artifactStore = new ContextArtifactStore(db);
      const rocEvents: string[] = [];
      const rocMessages = createFixedCorpus();
      const rocSummaryInputs: BaseMessage[][] = [];
      const rocSummaryOutputs: string[] = [];
      await runContextCompactionForTest({
        artifactStore,
        budgetProfile: {
          contextWindowTokens: 1200,
          modelInputTokens: 500,
          reservedOutputTokens: 300,
          systemToolOverheadTokens: 200,
          summaryInputTokens: 2000,
          safetyMarginTokens: 200
        },
        countTokens: async (messages) => countTokensApproximately(messages),
        emitEvent: (event) => rocEvents.push(event.type),
        messages: rocMessages,
        mode: 'run',
        model: {} as never,
        runId: 'run_native_conformance',
        summarize: async (input) => {
          rocSummaryInputs.push([...input.messages]);
          const source = `${input.goal}\n${messageText(input.messages)}`;
          const summary = {
            goal: source.includes('PROJECT=Atlas') ? 'PROJECT=Atlas' : 'goal_missing',
            facts: source.includes('PROJECT=Atlas') ? ['PROJECT=Atlas'] : [],
            decisions: source.includes('DECISION=SQLite') ? ['DECISION=SQLite'] : [],
            filesTouched: [],
            toolEvidence: source.includes('EVIDENCE=schema-v2') ? ['EVIDENCE=schema-v2'] : [],
            verification: [],
            openQuestions: [],
            nextActions: source.includes('NEXT=verification') ? ['NEXT=verification'] : []
          };
          rocSummaryOutputs.push(JSON.stringify(summary));
          return summary;
        },
        threadId: 'thread_native_conformance',
        toolResultPersistChars: 500,
        workspaceHash: 'workspace_native_conformance',
        workspacePath: 'F:\\Code\\Roc'
      });

      const nativeText = messageText(deliveredByNative);
      const rocText = messageText(rocMessages);
      expect(nativeAuditEvents).toEqual(['context_summary_started', 'context_summary_completed']);
      const completionOutcomes = [nativeDelivered.length === 1, rocEvents.includes('context_summary_completed')];
      expect(completionOutcomes.filter((completed) => completed)).toHaveLength(completionOutcomes.length);
      for (const marker of FIDELITY_MARKERS) {
        expect(nativeText).toContain(marker);
        expect(rocText).toContain(marker);
      }
      expect(nativeSummaryInputs).toHaveLength(1);
      expect(rocSummaryInputs).toHaveLength(1);
      expect(rocSummaryOutputs).toHaveLength(1);
      const tokenComparison = {
        nativeInputTokens: countTokensApproximately(nativeSummaryInputs[0]!),
        rocInputTokens: countTokensApproximately(rocSummaryInputs[0]!),
        nativeOutputTokens: countTokensApproximately([new AIMessage(nativeSummaryOutputs[0])]),
        rocOutputTokens: countTokensApproximately([new AIMessage(rocSummaryOutputs[0])])
      };
      expect(tokenComparison.rocInputTokens).toBeLessThan(tokenComparison.nativeInputTokens);
      expect(tokenComparison.nativeOutputTokens).toBeLessThan(tokenComparison.rocOutputTokens);
      expect(countTokensApproximately(deliveredByNative)).toBeLessThan(countTokensApproximately(nativeMessages));
      expect(countTokensApproximately(rocMessages)).toBeLessThanOrEqual(500);

      const nativeArtifact = [...nativeWrites.values()].join('\n');
      expect(nativeArtifact).toContain('EVIDENCE=schema-v2');
      const rocArtifact = db.prepare(
        `SELECT id, sha256 FROM context_artifacts
         WHERE thread_id = ? AND kind = 'tool_result'`
      ).get('thread_native_conformance') as { id: string; sha256: string } | undefined;
      if (rocArtifact === undefined) {
        throw new Error('roc_context_artifact_missing');
      }
      const recoveredRocArtifact = artifactStore.readArtifact({
        artifactId: rocArtifact.id,
        expectedSha256: rocArtifact.sha256,
        threadId: 'thread_native_conformance',
        workspaceHash: 'workspace_native_conformance'
      });
      expect(recoveredRocArtifact?.content).toContain('EVIDENCE=schema-v2');

      const checkpointer = new RocSqliteCheckpointer(db);
      await checkpointer.put(
        { configurable: { thread_id: 'thread_native_checkpoint', checkpoint_ns: '' } },
        {
          v: 4,
          id: 'checkpoint_native_conformance',
          ts: '2026-07-23T00:00:00.000Z',
          channel_values: { messages: nativeMessages, ...nativeUpdate },
          channel_versions: { messages: 1 },
          versions_seen: {}
        },
        { source: 'input', step: 1, parents: {} },
        {}
      );
      await checkpointer.put(
        { configurable: { thread_id: 'thread_roc_checkpoint', checkpoint_ns: '' } },
        {
          v: 4,
          id: 'checkpoint_roc_conformance',
          ts: '2026-07-23T00:00:00.000Z',
          channel_values: { messages: rocMessages },
          channel_versions: { messages: 1 },
          versions_seen: {}
        },
        { source: 'input', step: 1, parents: {} },
        {}
      );
      const checkpointRows = db.prepare(
        `SELECT thread_id, length(checkpoint_blob) AS bytes
         FROM langgraph_checkpoints
         WHERE thread_id IN (?, ?)`
      ).all('thread_native_checkpoint', 'thread_roc_checkpoint') as Array<{ thread_id: string; bytes: number }>;
      const nativeCheckpointBytes = checkpointRows.find((row) => row.thread_id === 'thread_native_checkpoint')?.bytes;
      const rocCheckpointBytes = checkpointRows.find((row) => row.thread_id === 'thread_roc_checkpoint')?.bytes;
      if (nativeCheckpointBytes === undefined || rocCheckpointBytes === undefined) {
        throw new Error('conformance_checkpoint_rows_missing');
      }
      expect(rocCheckpointBytes).toBeLessThan(nativeCheckpointBytes);
    } finally {
      db.close();
    }
  });

  it('keeps compiled subagents on one Roc compaction producer and preserves cache', async () => {
    const db = new Database(':memory:');
    try {
      applyAgentDatabaseSchema(db);
      const artifactStore = new ContextArtifactStore(db);
      const model = {
        getName: () => 'ChatAnthropic',
        invoke: vi.fn()
      };
      const capabilityManifest = compileRunCapabilityManifest({
        deleteFileApprovalMode: 'fully_automatic',
        mcpApprovalMode: 'fully_automatic',
        mcpServers: [],
        requestedCapabilities: { mcpServers: [], skills: [] },
        skills: [],
        mode: 'chat',
        workflowHint: null
      }).manifest;
      buildDeepAgent({
        snapshot: createDeepAgentTestSnapshot({
          capabilityManifest,
          runId: 'run_subagent_conformance',
          threadId: 'thread_subagent_conformance',
          workspacePath: 'F:\\Code\\Roc',
          workspaceHash: 'workspace_subagent_conformance',
          budget: { contextBudgetTokens: 500 }
        }),
        model: model as never,
        systemPrompt: 'system',
        backend: {} as never,
        store: {} as never,
        memorySources: [],
        skillSources: ['/skills/'],
        subagents: [
          {
            name: 'research',
            description: 'Research fixed context.',
            systemPrompt: 'Research fixed context.',
            model: 'claude-conformance',
            tools: []
          }
        ],
        tools: [],
        checkpointer: undefined,
        contextCompaction: {
          artifactStore,
          budgetProfile: {
            contextWindowTokens: 1200,
            modelInputTokens: 500,
            reservedOutputTokens: 300,
            systemToolOverheadTokens: 200,
            summaryInputTokens: 400,
            safetyMarginTokens: 200
          },
          emitEvent: () => {},
          tokenCounter: {
            countMessages: async () => ({ estimated: false, tokens: 1 }),
            countText: async () => ({ estimated: false, tokens: 1 }),
            wasEstimated: () => false
          }
        }
      });

      ensureRocHarnessProfilesRegistered();
      const profile = getHarnessProfile('anthropic:conformance-model');
      expect(profile?.excludedMiddleware.has('SummarizationMiddleware')).toBe(true);

      const deepAgentInput = vi.mocked(createDeepAgent).mock.calls.at(-1)?.[0];
      if (deepAgentInput === undefined) {
        throw new Error('deep_agent_conformance_input_missing');
      }
      const subagents = deepAgentInput.subagents;
      if (!Array.isArray(subagents) || subagents.length !== 2) {
        throw new Error('deep_agent_compiled_subagents_missing');
      }
      expect(subagents.map((subagent) => subagent.name)).toEqual(['general-purpose', 'research']);
      for (const subagent of subagents) {
        if (!isBuiltSubagent(subagent)) {
          throw new Error('deep_agent_compiled_subagent_invalid');
        }
        const middleware = getSubagentMiddleware(subagent);
        const names = middleware.map((item) => Reflect.get(item as object, 'name'));
        expect(names).toEqual(expect.arrayContaining([
          'todoListMiddleware',
          'FilesystemMiddleware',
          'patchToolCallsMiddleware',
          'PromptCachingMiddleware',
          'RocCacheBreakpointMiddleware',
          'RocContextCompactionPipeline'
        ]));
        if (Reflect.get(subagent as object, 'name') === 'general-purpose') {
          expect(names).toContain('SkillsMiddleware');
        }
        expect(names.filter((name) => name === 'RocContextCompactionPipeline')).toHaveLength(1);
        expect(names).not.toContain('SummarizationMiddleware');

        const cacheBreakpoint = middleware.find((item) =>
          Reflect.get(item as object, 'name') === 'RocCacheBreakpointMiddleware'
        );
        const wrapModelCall = Reflect.get(cacheBreakpoint as object, 'wrapModelCall');
        if (typeof wrapModelCall !== 'function') {
          throw new Error('subagent_cache_breakpoint_missing');
        }
        const cacheKeys: string[] = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await wrapModelCall(
            {
              messages: [],
              model,
              runtime: { context: {} },
              state: { messages: [] },
              systemMessage: new SystemMessage({ content: 'stable system prompt' }),
              tools: []
            },
            async (request: { systemMessage: SystemMessage }) => {
              const content = request.systemMessage.content;
              if (!Array.isArray(content)) {
                throw new Error('subagent_cache_breakpoint_content_missing');
              }
              expect(Reflect.get(content.at(-1) as object, 'cache_control')).toEqual({ type: 'ephemeral' });
              cacheKeys.push(JSON.stringify(content));
              return new AIMessage({ content: 'cache inspected' });
            }
          );
        }
        expect(new Set(cacheKeys).size).toBe(1);
      }
    } finally {
      db.close();
    }
  });
});

function createFixedCorpus(): BaseMessage[] {
  return [
    new HumanMessage({ id: 'goal', content: `PROJECT=Atlas ${'goal '.repeat(120)}` }),
    mark(new AIMessage({ id: 'analysis-1', content: 'Initial analysis.' }), 1),
    new HumanMessage({ id: 'decision', content: `Must preserve DECISION=SQLite ${'constraint '.repeat(90)}` }),
    mark(new AIMessage({
      id: 'tool-call',
      content: '',
      tool_calls: [{ id: 'call-schema', name: 'read_file', args: { file_path: '/workspace/schema.sql' } }]
    }), 2),
    mark(new ToolMessage({
      id: 'tool-result',
      tool_call_id: 'call-schema',
      name: 'read_file',
      content: `EVIDENCE=schema-v2 ${'table definition '.repeat(360)}`,
      status: 'success'
    }), 2),
    new HumanMessage({ id: 'notes', content: `Capture migration notes. ${'note '.repeat(120)}` }),
    mark(new AIMessage({ id: 'analysis-2', content: 'Migration notes captured.' }), 3),
    mark(new HumanMessage({ id: 'next', content: 'NEXT=verification' }), 4),
    mark(new AIMessage({ id: 'recent', content: 'Ready for the verification step.' }), 4)
  ];
}

function mark<M extends BaseMessage>(message: M, iteration: number): M {
  return markIterationOnMessage(message, iteration) as M;
}

function messageText(messages: readonly BaseMessage[]): string {
  return messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
}

function seedThread(db: Database.Database, threadId: string): void {
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    threadId,
    'chat',
    threadId,
    threadId,
    'running',
    '2026-07-23T00:00:00.000Z',
    '2026-07-23T00:00:00.000Z'
  );
}
