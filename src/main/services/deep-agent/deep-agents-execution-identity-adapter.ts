import type { RunCapabilityExecutionScopeV1 } from '../../../shared/types';
import { getConfig } from '@langchain/langgraph';

export type DeepAgentsExecutionIdentity = {
  executionPath: string;
  checkpointId: string;
};

/** Use LangGraph's public executionInfo, not private configurable fields or node-name prefixes. */
export function readDeepAgentsExecutionIdentity(
  executionInfo: unknown,
  scope: RunCapabilityExecutionScopeV1
): DeepAgentsExecutionIdentity | null {
  if (!isRecord(executionInfo) || typeof executionInfo.checkpointId !== 'string' ||
      executionInfo.checkpointId.length === 0 || typeof executionInfo.checkpointNs !== 'string' ||
      typeof executionInfo.taskId !== 'string' || executionInfo.taskId.length === 0) {
    return null;
  }
  return {
    executionPath: scope === 'main' ? 'main' : `subagent/${executionInfo.checkpointNs}`,
    checkpointId: executionInfo.checkpointId
  };
}

/**
 * LangChain 1.6 ToolNode does not copy `executionInfo` into middleware runtime.
 * LangGraph's public getConfig() retains it in the current async task context.
 */
export function readCurrentDeepAgentsExecutionIdentity(
  runtime: { executionInfo?: unknown } | undefined,
  scope: RunCapabilityExecutionScopeV1
): DeepAgentsExecutionIdentity | null {
  if (runtime?.executionInfo !== undefined) {
    return readDeepAgentsExecutionIdentity(runtime.executionInfo, scope);
  }
  try {
    return readDeepAgentsExecutionIdentity(getConfig().executionInfo, scope);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
