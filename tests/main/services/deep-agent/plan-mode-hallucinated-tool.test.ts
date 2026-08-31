import Database from 'better-sqlite3';

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput
} from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { InMemoryStore } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { buildDeepAgent, type DeepAgentBuildInput } from '../../../../src/main/services/deep-agent/agent-builder';
import type { RocCompositeBackend } from '../../../../src/main/services/deep-agent/backend';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';
import { createDeepAgentTestSnapshot } from '../../deep-agent-test-helpers';
import { defaultErrorTracker } from '../../../../src/main/services/forge-guardrails';
import type {
  RunCapabilityManifestToolV1,
  RunCapabilityManifestV1
} from '../../../../src/shared/types';

type ScriptedModelState = {
  nextResponseIndex: number;
};

class ScriptedToolModel extends BaseChatModel {
  private readonly responses: readonly AIMessage[];
  private readonly state: ScriptedModelState;

  constructor(responses: readonly AIMessage[], state?: ScriptedModelState) {
    super({});
    this.responses = responses;
    this.state = state === undefined ? { nextResponseIndex: 0 } : state;
  }

  override _llmType(): string {
    return 'roc-plan-hallucinated-tool-scripted';
  }

  override bindTools(_tools: BindToolsInput[], _kwargs?: Partial<BaseChatModelCallOptions>): ScriptedToolModel {
    return new ScriptedToolModel(this.responses, this.state);
  }

  override async _generate(): Promise<ChatResult> {
    const response = this.responses[this.state.nextResponseIndex];
    if (response === undefined) {
      throw new Error('plan_hallucinated_tool_model_sequence_exhausted');
    }
    this.state.nextResponseIndex += 1;
    return {
      generations: [
        {
          message: response,
          text: typeof response.content === 'string' ? response.content : ''
        }
      ],
      llmOutput: {}
    };
  }
}

describe('plan mode hallucinated tool recovery', () => {
  it('returns a self-correctable tool message when the model invents a tool name that has no runtime binding', async () => {
    const db = createAgentDatabase();
    try {
      const agent = createPlanModeAgent({
        db,
        model: hallucinatedWriteModel('call-hallucinated-write')
      });

      const result = await agent.invoke(
        initialState('record the clarification the user just gave'),
        { configurable: { thread_id: 'thread-plan-hallucinated-write' } }
      );
      const message = requireToolMessage(result.messages, 'call-hallucinated-write');

      expect(message.status).toBe('error');
      expect(message.content).toContain('write');
      expect(message.content).toContain('not an available tool');
    } finally {
      db.close();
    }
  });

  it('keeps a runtime-bound but unauthorized tool call fatal so manifest leaks stay visible', async () => {
    const db = createAgentDatabase();
    try {
      // read_file 由 deepagents filesystem middleware 声明，运行时已绑定，且不在 plan 黑名单，
      // 因此能穿过 PlanRuntimeToolGuard 抵达 ToolProtocol；manifest 为空即真实授权泄漏。
      const agent = createPlanModeAgent({
        db,
        manifestTools: [],
        model: hallucinatedWriteModel('call-unauthorized-read-file', 'read_file', {
          file_path: '/memory/global/MEMORY.md'
        })
      });

      await expect(
        agent.invoke(
          initialState('read the memory file'),
          { configurable: { thread_id: 'thread-plan-unauthorized-read-file' } }
        )
      ).rejects.toThrow('agent_capability_manifest_tool_not_authorized:read_file');
    } finally {
      db.close();
    }
  });
});

function createAgentDatabase(): Database.Database {
  const db = new Database(':memory:');
  applyAgentDatabaseSchema(db);
  return db;
}

function createPlanModeAgent(input: {
  db: Database.Database;
  manifestTools?: RunCapabilityManifestToolV1[];
  model: BaseChatModel;
}) {
  const backend = Object.assign(new StateBackend(), { routePrefixes: [] }) as RocCompositeBackend;
  const buildInput: DeepAgentBuildInput = {
    snapshot: createDeepAgentTestSnapshot({
      capabilityManifest: manifestFor(
        input.manifestTools ?? [
          manifestTool('read_file'),
          manifestTool('write_file'),
          manifestTool('edit_file'),
          manifestTool('ls'),
          manifestTool('glob'),
          manifestTool('grep'),
          manifestTool('write_todos')
        ]
      ),
      mode: 'plan',
      runId: 'run-plan-hallucinated',
      threadId: 'thread-plan-hallucinated',
      workspacePath: 'F:\\Code\\Roc',
      budget: { contextBudgetTokens: null }
    }),
    model: input.model,
    systemPrompt: 'Plan only. Do not implement changes.',
    backend,
    store: new InMemoryStore(),
    memorySources: [],
    skillSources: [],
    subagents: [],
    tools: [],
    checkpointer: new RocSqliteCheckpointer(input.db)
  };
  return buildDeepAgent(buildInput);
}

function hallucinatedWriteModel(
  toolCallId: string,
  toolName = 'write',
  args: Record<string, unknown> = { file_path: '/memory/global/MEMORY.md', content: 'x' }
): ScriptedToolModel {
  return new ScriptedToolModel([
    new AIMessage({
      id: `ai-${toolCallId}`,
      content: '',
      tool_calls: [{ name: toolName, id: toolCallId, args, type: 'tool_call' }]
    }),
    new AIMessage({ id: `ai-${toolCallId}-terminal`, content: 'done' })
  ]);
}

function initialState(prompt: string) {
  return {
    forge_error_tracker: defaultErrorTracker(),
    messages: [new HumanMessage(prompt)]
  };
}

function manifestFor(tools: RunCapabilityManifestToolV1[]): RunCapabilityManifestV1 {
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

function manifestTool(modelVisibleName: string): RunCapabilityManifestToolV1 {
  return {
    canonicalIdentity: `builtin:${modelVisibleName}`,
    modelVisibleName,
    provenance: { kind: 'builtin', source: 'roc' },
    executionScopes: ['main', 'subagent'],
    riskLevel: 'low',
    effectClass: 'none',
    approvalPolicy: { kind: 'none' },
    idempotencyStrategy: 'none',
    reconcileStrategy: 'none',
    resourceScope: 'workspace'
  };
}

function requireToolMessage(messages: readonly BaseMessage[], toolCallId: string): ToolMessage {
  const message = messages.find(
    (candidate) => ToolMessage.isInstance(candidate) && candidate.tool_call_id === toolCallId
  );
  if (!ToolMessage.isInstance(message)) {
    throw new Error(`plan_hallucinated_tool_message_missing:${toolCallId}`);
  }
  return message;
}
