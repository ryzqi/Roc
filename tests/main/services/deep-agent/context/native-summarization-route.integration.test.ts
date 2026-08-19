import Database from 'better-sqlite3';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { InMemoryStore } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { FakeToolCallingModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../../src/main/infrastructure/database-schemas';
import { compileRunCapabilityManifest } from '../../../../../src/main/plugins/agent/run-capability-manifest';
import { buildDeepAgent } from '../../../../../src/main/services/deep-agent/agent-builder';
import type { RocCompositeBackend } from '../../../../../src/main/services/deep-agent/backend';
import { ContextArtifactStore } from '../../../../../src/main/services/deep-agent/context/context-artifact-store';
import { defaultErrorTracker } from '../../../../../src/main/services/forge-guardrails';
import { RocSqliteCheckpointer } from '../../../../../src/main/services/deep-agent/sqlite-checkpointer';

class AnthropicFakeToolCallingModel extends FakeToolCallingModel {
  override getName(): string {
    return 'ChatAnthropic';
  }
}

describe('Deep Agents native summarization route integration', () => {
  it('runs the real main-to-compiled-subagent task route with only Roc compaction', async () => {
    const db = new Database(':memory:');
    try {
      applyAgentDatabaseSchema(db);
      db.prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'thread_real_subagent_route',
        'chat',
        'Route conformance',
        'Route conformance',
        'running',
        '2026-07-23T00:00:00.000Z',
        '2026-07-23T00:00:00.000Z'
      );
      const contextEvents: string[] = [];
      const model = new AnthropicFakeToolCallingModel({
        structuredResponse: {
          goal: 'Preserve the delegated route.',
          facts: ['The research subagent updated its todo list.'],
          decisions: [],
          filesTouched: [],
          toolEvidence: [],
          verification: [],
          openQuestions: [],
          nextActions: ['Return to the main agent.']
        },
        toolCalls: [
          [
            {
              name: 'task',
              args: {
                description: 'Return a concise route result.',
                subagent_type: 'research'
              },
              id: 'call_route_research'
            }
          ],
          [
            {
              name: 'write_todos',
              args: {
                todos: [{ content: 'Complete delegated route.', status: 'in_progress' }]
              },
              id: 'call_route_todo'
            }
          ],
          [],
          []
        ]
      });
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
      const agent = buildDeepAgent({
        mode: 'run',
        model,
        systemPrompt: 'Delegate the request to the research subagent.',
        backend,
        store: new InMemoryStore(),
        memorySources: [],
        skillSources: [],
        subagents: [
          {
            name: 'research',
            description: 'Research route fixture.',
            systemPrompt: 'Complete the delegated request.',
            tools: []
          }
        ],
        tools: [],
        capabilityManifest,
        filesystemPermissions: [],
        workspacePath: 'F:\\Code\\Roc',
        interruptOn: undefined,
        checkpointer: new RocSqliteCheckpointer(db),
        workflowHint: null,
        contextBudgetTokens: 500,
        contextCompaction: {
          artifactStore: new ContextArtifactStore(db),
          budgetProfile: {
            contextWindowTokens: 1200,
            modelInputTokens: 500,
            reservedOutputTokens: 300,
            systemToolOverheadTokens: 200,
            summaryInputTokens: 400,
            safetyMarginTokens: 200
          },
          emitEvent: (event) => contextEvents.push(event.type),
          mode: 'run',
          runId: 'run_real_subagent_route',
          threadId: 'thread_real_subagent_route',
          tokenCounter: {
            countMessages: async (messages) => ({
              estimated: false,
              tokens: messages.length >= 3 ? 470 : 1
            }),
            countText: async () => ({ estimated: false, tokens: 1 }),
            wasEstimated: () => false
          },
          workspaceHash: 'workspace_real_subagent_route'
        },
        modelCallLimit: 20,
        modelThreadCallLimit: 100,
        toolCallLimit: 40,
        toolThreadCallLimit: 200
      });

      const options = Reflect.get(agent as object, 'options');
      if (options === null || typeof options !== 'object') {
        throw new Error('real_deep_agent_options_missing');
      }
      const middleware = Reflect.get(options, 'middleware');
      if (!Array.isArray(middleware)) {
        throw new Error('real_deep_agent_middleware_missing');
      }
      const middlewareNames = middleware.map((item) => Reflect.get(item as object, 'name'));
      expect(middlewareNames.filter((name) => name === 'RocContextCompactionPipeline')).toHaveLength(1);
      expect(middlewareNames).not.toContain('SummarizationMiddleware');

      const result = await agent.invoke(
        {
          forge_error_tracker: defaultErrorTracker(),
          messages: [new HumanMessage('Delegate this request.')]
        },
        { configurable: { thread_id: 'thread_real_subagent_route' } }
      );
      expect(result.messages.some((message: BaseMessage) =>
        AIMessage.isInstance(message) && message.tool_calls?.some((toolCall) => toolCall.name === 'task') === true
      )).toBe(true);
      expect(result.messages.some((message: BaseMessage) =>
        ToolMessage.isInstance(message) && message.tool_call_id === 'call_route_research'
      )).toBe(true);
      const checkpointCount = db.prepare('SELECT COUNT(*) AS count FROM langgraph_checkpoints').get() as { count: number };
      expect(checkpointCount.count).toBeGreaterThan(0);
      expect(contextEvents.filter((event) => event === 'context_compaction_started').length).toBeGreaterThanOrEqual(4);
      expect(contextEvents).toContain('context_summary_completed');
    } finally {
      db.close();
    }
  });
});
