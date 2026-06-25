import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

import {
  ROC_FILE_TOOL_MISSING_PATH_ERROR,
  getRocFileToolPathField,
  normalizeRocFileToolPath,
  validateRocFileToolPath
} from './filesystem-tool-contract';

type ToolCallNormalizationResult<TRequest extends ToolCallRequest> =
  | { ok: true; path: string; request: TRequest }
  | { ok: false; error: string };

type ToolCallRequest = {
  toolCall: {
    args?: unknown;
    id?: string;
    name: string;
  };
};

export { normalizeRocFileToolPath, validateRocFileToolPath };

export function createRocFilesystemPathPolicyMiddleware() {
  return createMiddleware({
    name: 'RocFilesystemPathPolicyMiddleware',
    wrapToolCall: async (request, handler) => {
      const validation = normalizeFilesystemToolCall(request);
      if (validation.ok) {
        return await handler(validation.request);
      }
      return new ToolMessage({
        tool_call_id: request.toolCall.id ?? 'unknown-tool-call',
        name: request.toolCall.name,
        content: validation.error,
        status: 'error'
      });
    }
  });
}

function normalizeFilesystemToolCall<TRequest extends ToolCallRequest>(
  request: TRequest
): ToolCallNormalizationResult<TRequest> {
  const pathField = getRocFileToolPathField(request.toolCall.name);
  if (pathField === null) {
    return { ok: true, path: '', request };
  }
  if (!isRecord(request.toolCall.args)) {
    return { ok: false, error: ROC_FILE_TOOL_MISSING_PATH_ERROR };
  }
  const path = request.toolCall.args[pathField];
  if (typeof path !== 'string') {
    return { ok: false, error: ROC_FILE_TOOL_MISSING_PATH_ERROR };
  }
  const normalized = normalizeRocFileToolPath(path);
  if (!normalized.ok) {
    return normalized;
  }
  return { ok: true, path, request };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
