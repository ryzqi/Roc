import { createMiddleware } from 'langchain';
import type { RunCapabilityExecutionScopeV1, RunCapabilityManifestV1 } from '../../../shared/types';

const JSON_HANDOFF_FIELDS_BY_TOOL = {
  propose_background_task: new Set(['trigger']),
  update_background_task: new Set(['patch.trigger'])
} as const;

export type ToolProtocolOptions = {
  capabilityManifest: RunCapabilityManifestV1;
  executionScope: RunCapabilityExecutionScopeV1;
};

export function createToolProtocolMiddleware(_options: ToolProtocolOptions) {
  return createMiddleware({
    name: 'RocToolProtocolMiddleware',
    wrapToolCall: async (request, handler) => {
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
