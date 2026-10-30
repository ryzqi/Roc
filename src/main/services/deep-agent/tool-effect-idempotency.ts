import { ToolMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { createMiddleware } from 'langchain';

import type {
  RunCapabilityManifestToolV1,
  RunCapabilityManifestV1,
  RunCapabilityReconcileStrategyV1
} from '../../../shared/types';
import { RocToolResolutionError } from '../forge-guardrails/errors';
import { unwrapMiddlewareError } from '../forge-guardrails/middleware/middleware-error';
import { toRunFailure } from './error-mapping';
import type { CapabilityOperationReceipt } from '../../kernel/capability-operation-context';
import {
  createCapabilityOperationContext,
  runWithCapabilityOperationContext
} from '../../kernel/capability-operation-context';
import { readDeepAgentsExecutionIdentity } from './deep-agents-execution-identity-adapter';
import { AgentToolEffectStore, type ToolEffectKey } from './tool-effect-store';

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
    configurable?: unknown;
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
        return handler(request);
      }

      const toolCallId = readToolCallId(typedRequest);
      if (toolCallId === null) {
        return createEffectErrorMessage(typedRequest.toolCall.name, 'unknown-tool-call', 'agent_tool_effect_call_id_missing');
      }
      const executionIdentity = readDeepAgentsExecutionIdentity(typedRequest.runtime?.configurable);
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
      const toolVersion = policy.toolVersion ?? `legacy-manifest-v1:${options.capabilityManifest.manifestHash}`;
      const operation = options.store.beginOperation({
        ...key,
        threadId: options.threadId,
        toolName: typedRequest.toolCall.name,
        canonicalToolIdentity: policy.canonicalIdentity,
        toolVersion,
        args: typedRequest.toolCall.args,
        effectClass: effectPolicy.effectClass,
        reconcileStrategy: effectPolicy.reconcileStrategy
      });
      if (operation.kind === 'replay') {
        return deserializeToolResult(operation.result);
      }

      const lease = operation.lease;
      const operationContext = createCapabilityOperationContext({
        operationId: lease.operationId,
        idempotencyKey: lease.idempotencyKey,
        toolCallId: lease.toolCallId,
        toolName: lease.toolName,
        canonicalToolIdentity: lease.canonicalToolIdentity,
        toolVersion: lease.toolVersion,
        attemptId: lease.attemptId,
        leaseGeneration: lease.leaseGeneration,
        recordReceipt: (receipt: CapabilityOperationReceipt) => options.store.recordReceipt(lease, receipt)
      });
      options.store.markStarted(lease);
      try {
        const result = await runWithCapabilityOperationContext(operationContext, () => handler(request));
        if (!ToolMessage.isInstance(result)) {
          throw new Error('agent_tool_effect_result_not_tool_message');
        }
        const storedResult = serializeToolResult(result);
        if (result.status === 'error') {
          const error = createToolMessageFailure(result);
          if (operationContext.hasPublishedSideEffect()) {
            options.store.finishUnknown(lease, error);
          } else {
            options.store.finishError(lease, error, false);
          }
          return result;
        }
        options.store.finishSuccess(lease, storedResult);
        return result;
      } catch (error) {
        const toolError = unwrapMiddlewareError(error);
        if (operationContext.hasPublishedSideEffect() || effectPolicy.reconcileStrategy === 'manual_confirmation') {
          options.store.finishUnknown(lease, toolError);
        } else {
          options.store.finishError(
            lease,
            toolError,
            !(toolError instanceof RocToolResolutionError) && toRunFailure(toolError).retryable
          );
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
  if (tool.reconcileStrategy === undefined) {
    throw new Error(`agent_tool_effect_manifest_reconcile_missing:${tool.modelVisibleName}`);
  }
  const reconcileStrategy = tool.reconcileStrategy;
  if (reconcileStrategy === 'none') {
    throw new Error(`agent_tool_effect_manifest_reconcile_invalid:${tool.modelVisibleName}`);
  }
  return {
    effectClass: tool.effectClass,
    reconcileStrategy
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

function createToolMessageFailure(message: ToolMessage): Error {
  if (typeof message.content === 'string' && message.content.length > 0) {
    return new Error(message.content);
  }
  return new Error('agent_tool_effect_tool_message_error');
}

function serializeToolResult(result: ToolMessage): StoredToolMessage {
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
  const name = message.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('agent_tool_effect_result_name_missing');
  }
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
