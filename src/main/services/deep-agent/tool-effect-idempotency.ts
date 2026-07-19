import { ToolMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { createMiddleware } from 'langchain';

import type {
  RunCapabilityManifestToolV1,
  RunCapabilityManifestV1,
  RunCapabilityReconcileStrategyV1
} from '../../../shared/types';
import { toRunFailure } from './error-mapping';
import { AgentToolEffectStore, hashToolInput, type ToolEffectKey } from './tool-effect-store';

type ToolEffectIdempotencyOptions = {
  runId: string;
  threadId: string;
  store: AgentToolEffectStore;
  capabilityManifest: RunCapabilityManifestV1;
};

type ToolCallRequest = {
  tool?: ClientTool;
  toolCall: {
    args: unknown;
    id?: string;
    name: string;
  };
  runtime?: {
    executionInfo?: {
      checkpointId: string;
      checkpointNs: string;
    };
  };
};

type StoredToolMessage = {
  kind: 'tool_message';
  content: ToolMessage['content'];
  metadata: ToolMessage['metadata'] | undefined;
  name: string;
  status: ToolMessage['status'] | undefined;
  toolCallId: string;
};

export function createToolEffectIdempotencyMiddleware(options: ToolEffectIdempotencyOptions) {
  const manifestTools = new Map(options.capabilityManifest.tools.map((tool) => [tool.modelVisibleName, tool]));
  return createMiddleware({
    name: 'RocToolEffectIdempotencyMiddleware',
    wrapToolCall: async (request, handler) => {
      const typedRequest = request as ToolCallRequest;
      const policy = manifestTools.get(typedRequest.toolCall.name);
      if (policy === undefined) {
        throw new Error(`agent_tool_effect_manifest_tool_missing:${typedRequest.toolCall.name}`);
      }
      if (policy.idempotencyStrategy === 'none') {
        return await handler(request);
      }

      const toolCallId = readToolCallId(typedRequest);
      if (toolCallId === null) {
        return createEffectErrorMessage(typedRequest.toolCall.name, 'unknown-tool-call', 'agent_tool_effect_call_id_missing');
      }
      const executionIdentity = readExecutionIdentity(typedRequest);
      if (executionIdentity === null) {
        return createEffectErrorMessage(typedRequest.toolCall.name, toolCallId, 'agent_tool_effect_execution_info_missing');
      }
      const effectPolicy = requireEffectPolicy(policy);
      const key: ToolEffectKey = {
        runId: options.runId,
        toolCallId,
        executionPath: executionIdentity.executionPath,
        checkpointId: executionIdentity.checkpointId
      };
      const inputHash = hashToolInput({
        args: typedRequest.toolCall.args,
        name: typedRequest.toolCall.name
      });
      const reusable = options.store.readReusable({ ...key, inputHash });
      if (reusable !== null) {
        return deserializeToolResult(reusable.result);
      }

      options.store.start({
        ...key,
        threadId: options.threadId,
        toolName: typedRequest.toolCall.name,
        inputHash,
        effectClass: effectPolicy.effectClass,
        reconcileStrategy: effectPolicy.reconcileStrategy
      });
      try {
        const result = await handler(request);
        options.store.finishSuccess({
          ...key,
          result: serializeToolResult(result)
        });
        return result;
      } catch (error) {
        if (effectPolicy.reconcileStrategy === 'manual_confirmation') {
          options.store.finishUnknown({ ...key, error });
        } else {
          options.store.finishError({
            ...key,
            error,
            retryable: toRunFailure(error).retryable
          });
        }
        throw error;
      }
    }
  });
}

function requireEffectPolicy(tool: RunCapabilityManifestToolV1): {
  effectClass: Exclude<RunCapabilityManifestToolV1['effectClass'], 'none'>;
  reconcileStrategy: Exclude<RunCapabilityReconcileStrategyV1, 'none'>;
} {
  if (tool.effectClass === 'none') {
    throw new Error(`agent_tool_effect_manifest_class_invalid:${tool.modelVisibleName}`);
  }
  const reconcileStrategy = tool.reconcileStrategy === undefined
    ? resolveLegacyReconcileStrategy(tool.effectClass)
    : tool.reconcileStrategy;
  if (reconcileStrategy === 'none') {
    throw new Error(`agent_tool_effect_manifest_reconcile_invalid:${tool.modelVisibleName}`);
  }
  return {
    effectClass: tool.effectClass,
    reconcileStrategy
  };
}

function resolveLegacyReconcileStrategy(
  effectClass: RunCapabilityManifestToolV1['effectClass']
): Exclude<RunCapabilityReconcileStrategyV1, 'none'> {
  return effectClass === 'network_read' ? 'retry_safe' : 'manual_confirmation';
}

function readExecutionIdentity(request: ToolCallRequest): { executionPath: string; checkpointId: string } | null {
  const executionInfo = request.runtime?.executionInfo;
  if (
    executionInfo === undefined ||
    typeof executionInfo.checkpointId !== 'string' ||
    typeof executionInfo.checkpointNs !== 'string' ||
    executionInfo.checkpointId.length === 0
  ) {
    return null;
  }
  return {
    executionPath: executionInfo.checkpointNs.length === 0 ? 'main' : `subagent/${executionInfo.checkpointNs}`,
    checkpointId: executionInfo.checkpointId
  };
}

function createEffectErrorMessage(toolName: string, toolCallId: string, content: string): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCallId,
    name: toolName,
    content,
    status: 'error'
  });
}

function serializeToolResult(result: unknown): StoredToolMessage {
  if (!ToolMessage.isInstance(result)) {
    throw new Error('agent_tool_effect_result_not_tool_message');
  }
  const name = readToolMessageName(result);
  return {
    kind: 'tool_message',
    content: result.content,
    metadata: result.metadata,
    name,
    status: result.status,
    toolCallId: result.tool_call_id
  };
}

function deserializeToolResult(result: unknown): ToolMessage {
  if (!isStoredToolMessage(result)) {
    throw new Error('agent_tool_effect_result_invalid');
  }
  return new ToolMessage({
    tool_call_id: result.toolCallId,
    name: result.name,
    content: result.content,
    status: result.status,
    metadata: result.metadata
  });
}

function isStoredToolMessage(value: unknown): value is StoredToolMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kind === 'tool_message' &&
    typeof value.name === 'string' &&
    typeof value.toolCallId === 'string' &&
    'content' in value
  );
}

function readToolCallId(request: ToolCallRequest): string | null {
  if (typeof request.toolCall.id !== 'string' || request.toolCall.id.length === 0) {
    return null;
  }
  return request.toolCall.id;
}

function readToolMessageName(message: ToolMessage): string {
  const name = Reflect.get(message, 'name');
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('agent_tool_effect_result_name_missing');
  }
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
