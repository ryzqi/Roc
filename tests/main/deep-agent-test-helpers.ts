import type { SubAgent } from 'deepagents';
import type {
  RunCapabilityManifestV1,
  RunExecutionSnapshotV2
} from '../../src/shared/types';

export type BuiltSubagent = SubAgent | { name: string; description: string; runnable: unknown };

export function isBuiltSubagent(value: unknown): value is BuiltSubagent {
  return value !== null && typeof value === 'object' && (Reflect.has(value, 'systemPrompt') || Reflect.has(value, 'runnable'));
}

export function getSubagentMiddleware(value: BuiltSubagent): readonly unknown[] {
  const direct = Reflect.get(value, 'middleware');
  if (Array.isArray(direct)) {
    return direct;
  }
  const options = readRunnableOptions(value);
  const middleware = Reflect.get(options, 'middleware');
  if (!Array.isArray(middleware)) {
    throw new Error('compiled_subagent_middleware_missing');
  }
  return middleware;
}

export function getSubagentTools(value: BuiltSubagent): readonly { name: string }[] {
  const direct = Reflect.get(value, 'tools');
  if (Array.isArray(direct)) {
    return direct as readonly { name: string }[];
  }
  const options = readRunnableOptions(value);
  const tools = Reflect.get(options, 'tools');
  if (!Array.isArray(tools)) {
    throw new Error('compiled_subagent_tools_missing');
  }
  return tools as readonly { name: string }[];
}

export function createDeepAgentTestSnapshot(input: {
  capabilityManifest: RunCapabilityManifestV1;
  budget?: Partial<RunExecutionSnapshotV2['budget']>;
  mode?: RunExecutionSnapshotV2['mode'];
  runId?: string;
  runOrigin?: RunExecutionSnapshotV2['runOrigin'];
  threadId?: string;
  workflowHint?: RunExecutionSnapshotV2['workflowHint'];
  workspaceHash?: string;
  workspacePath?: string | null;
}): RunExecutionSnapshotV2 {
  const workspacePath = input.workspacePath ?? null;
  return {
    schemaVersion: 2,
    runId: input.runId ?? 'run-test',
    threadId: input.threadId ?? 'thread-test',
    runOrigin: input.runOrigin ?? 'chat',
    model: {
      providerId: 'provider-test',
      modelId: 'model-test'
    },
    mode: input.mode ?? 'run',
    workspace: workspacePath === null
      ? null
      : {
          path: workspacePath,
          hash: input.workspaceHash ?? 'workspace-test-hash'
        },
    capabilityManifest: input.capabilityManifest,
    workflowHint: input.workflowHint ?? null,
    explicitSkillIds: [],
    inputMessageId: 'message-test',
    dispatchKey: null,
    budget: {
      contextBudgetTokens: input.budget?.contextBudgetTokens ?? null,
      modelCallLimit: input.budget?.modelCallLimit ?? 20,
      modelThreadCallLimit: input.budget?.modelThreadCallLimit ?? 100,
      toolCallLimit: input.budget?.toolCallLimit ?? 40,
      toolThreadCallLimit: input.budget?.toolThreadCallLimit ?? 200
    }
  };
}

function readRunnableOptions(value: BuiltSubagent): object {
  const runnable = Reflect.get(value, 'runnable');
  if (runnable === null || typeof runnable !== 'object') {
    throw new Error('compiled_subagent_runnable_missing');
  }
  const options = Reflect.get(runnable, 'options');
  if (options === null || typeof options !== 'object') {
    throw new Error('compiled_subagent_options_missing');
  }
  return options;
}
