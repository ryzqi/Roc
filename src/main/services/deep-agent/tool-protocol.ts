import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1 } from '../../../shared/types';

const JSON_HANDOFF_FIELDS_BY_TOOL = {
  propose_background_task: new Set(['trigger']),
  update_background_task: new Set(['patch.trigger'])
} as const;

export type ToolProtocolOptions = {
  capabilityManifest: RunCapabilityManifestV1;
  executionScope: RunCapabilityExecutionScopeV1;
  /** 运行时实际绑定给 ToolNode 的工具名。用于把模型幻觉的名字与真实授权泄漏区分开。 */
  boundToolNames: readonly string[];
};

export function createToolProtocolMiddleware(_options: ToolProtocolOptions) {
  return createMiddleware({
    name: 'RocToolProtocolMiddleware',
    wrapToolCall: async (request, handler) => {
      const unboundToolCall = detectUnboundToolCall(_options, request);
      if (unboundToolCall !== null) {
        return unboundToolCall;
      }
      assertCapabilityManifestToolContract(_options, request);
      const normalizedArgs = normalizeToolCallArgs(request.toolCall.name, request.toolCall.args);
      if (normalizedArgs === request.toolCall.args) {
        return await handler(request);
      }
      return await handler({
        ...request,
        toolCall: {
          ...request.toolCall,
          args: normalizedArgs as Record<string, unknown>
        }
      });
    }
  });
}

/**
 * 模型幻觉出的工具名（运行时无任何绑定）与真实授权泄漏必须区分处理。
 *
 * ToolProtocol 在中间件链里位于 ToolRuntimeError / ToolResolution 的**外层**
 * （langchain 语义：数组首个为最外层），所以它一旦 throw，内层软化中间件全部够不着，
 * 异常冒泡到 ToolNode 后按 middleware error 处理，直接终止整个 run。
 *
 * 模型编造一个不存在的名字（例如把 write_file 说成 write）属可恢复的模型行为错误，
 * langchain 原生 ToolNode 对此返回软错误让模型自纠（nodes/ToolNode.js 的 baseHandler）。
 * 这里对齐该行为，仅在两个条件同时成立时软化：
 *   1. request.tool 缺失——ToolNode 的注册表里查不到该名字；
 *   2. 名字不在 boundToolNames 里——排除链上中间件丢掉 tool 字段的情况。
 * 反之工具确实绑定给了模型却不在 manifest，属真实授权泄漏，必须保持硬失败。
 */
function detectUnboundToolCall(
  options: ToolProtocolOptions,
  request: { tool?: unknown; toolCall: { id?: string; name: string } }
): ToolMessage | null {
  if (request.tool !== undefined && request.tool !== null) {
    return null;
  }
  if (options.boundToolNames.includes(request.toolCall.name)) {
    return null;
  }
  const authorizedToolNames = options.capabilityManifest.tools
    .filter((tool) => tool.executionScopes.includes(options.executionScope))
    .map((tool) => tool.modelVisibleName);
  return new ToolMessage({
    tool_call_id: request.toolCall.id === undefined || request.toolCall.id.length === 0
      ? `unknown_${request.toolCall.name}`
      : request.toolCall.id,
    name: request.toolCall.name,
    content: `${request.toolCall.name} is not an available tool. Available tools: ${authorizedToolNames.join(', ')}.`,
    status: 'error'
  });
}

function assertCapabilityManifestToolContract(
  options: ToolProtocolOptions,
  request: { tool?: unknown; toolCall: { name: string } }
): void {
  let runtimeToolName: unknown;
  if (request.tool !== null && typeof request.tool === 'object') {
    runtimeToolName = Reflect.get(request.tool, 'name');
  }
  if (typeof runtimeToolName === 'string' && runtimeToolName !== request.toolCall.name) {
    throw new Error(`agent_capability_manifest_tool_identity_mismatch:${request.toolCall.name}`);
  }
  const manifestTool = options.capabilityManifest.tools.find((tool) => tool.modelVisibleName === request.toolCall.name);
  if (manifestTool === undefined) {
    throw new Error(`agent_capability_manifest_tool_not_authorized:${request.toolCall.name}`);
  }
  if (!manifestTool.executionScopes.includes(options.executionScope)) {
    throw new Error(`agent_capability_manifest_scope_denied:${request.toolCall.name}:${options.executionScope}`);
  }
}

export function normalizeToolCallArgs(toolName: string, args: unknown): unknown {
  if (!isRecord(args)) {
    return args;
  }
  const stringFields = JSON_HANDOFF_FIELDS_BY_TOOL[toolName as keyof typeof JSON_HANDOFF_FIELDS_BY_TOOL];
  if (stringFields === undefined) {
    return args;
  }
  let changed = false;
  const next = { ...args };
  for (const fieldPath of stringFields) {
    const normalized = normalizeJsonField(next, fieldPath);
    changed ||= normalized.changed;
  }
  return changed ? next : args;
}

function normalizeJsonField(target: Record<string, unknown>, fieldPath: string): { changed: boolean } {
  const path = fieldPath.split('.');
  let container: Record<string, unknown> = target;
  for (const segment of path.slice(0, -1)) {
    const value = container[segment];
    if (!isRecord(value)) {
      return { changed: false };
    }
    const cloned = { ...value };
    container[segment] = cloned;
    container = cloned;
  }

  const key = path[path.length - 1];
  if (key === undefined) {
    return { changed: false };
  }
  const value = container[key];
  if (typeof value !== 'string') {
    return { changed: false };
  }
  const parsed = parseJsonRecord(value);
  if (parsed === null) {
    return { changed: false };
  }
  container[key] = parsed;
  return { changed: true };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
