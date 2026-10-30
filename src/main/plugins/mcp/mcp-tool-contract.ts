import { createHash } from 'node:crypto';
import { mcpToolContractSchema } from '../../../shared/schemas/ipc-mcp-skills';
import type { McpToolContractV1 } from '../../../shared/types';
import { DEFAULT_MCP_MAX_INBOUND_MESSAGE_BYTES } from './mcp-bounded-fetch';

export const MCP_TOOL_CONTRACT_VERSION = 1 as const;
export const MCP_TOOL_SCHEMA_CANONICALIZATION_VERSION = 1 as const;
export const MCP_MAX_TOOL_INPUT_BYTES = 64 * 1024;
export const MCP_MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
export const MCP_MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MCP_MAX_TOOL_DESCRIPTION_BYTES = 32 * 1024;

export type McpContractSource = {
  serverId: string;
  remoteToolName: string;
  runtimeToolName: string;
  transport: McpToolContractV1['transport'];
  inputSchema: unknown;
  outputSchema?: unknown;
  description: string;
};

export function createMcpToolContract(input: McpContractSource): McpToolContractV1 {
  const canonicalSchema = canonicalizeMcpJsonSchema({
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema ?? null
  });
  assertBytesBelow(canonicalSchema, MCP_MAX_TOOL_SCHEMA_BYTES, 'mcp_tool_schema_too_large');
  assertBytesBelow(input.description, MCP_MAX_TOOL_DESCRIPTION_BYTES, 'mcp_tool_description_too_large');
  return mcpToolContractSchema.parse({
    schemaVersion: MCP_TOOL_CONTRACT_VERSION,
    canonicalizationVersion: MCP_TOOL_SCHEMA_CANONICALIZATION_VERSION,
    serverId: input.serverId,
    remoteToolName: input.remoteToolName,
    runtimeToolName: input.runtimeToolName,
    transport: input.transport,
    schemaHash: sha256(canonicalSchema),
    descriptionHash: sha256(input.description),
    maxInputBytes: MCP_MAX_TOOL_INPUT_BYTES,
    maxOutputBytes: MCP_MAX_TOOL_OUTPUT_BYTES,
    maxInboundMessageBytes: DEFAULT_MCP_MAX_INBOUND_MESSAGE_BYTES
  });
}

export function canonicalizeMcpJsonSchema(input: unknown): string {
  const canonical = JSON.stringify(normalizeJsonSchemaValue(input));
  if (canonical === undefined) {
    throw new Error('mcp_tool_schema_not_json');
  }
  return canonical;
}

export function readMcpToolContractMetadata(input: unknown): McpToolContractV1 {
  if (!isRecord(input) || !isRecord(input.metadata) || !('mcpContract' in input.metadata)) {
    throw new Error('mcp_tool_contract_metadata_missing');
  }
  const parsed = mcpToolContractSchema.safeParse(input.metadata.mcpContract);
  if (!parsed.success) {
    throw new Error('mcp_tool_contract_metadata_invalid');
  }
  return parsed.data;
}

export function mcpToolContractsEqual(left: McpToolContractV1, right: McpToolContractV1): boolean {
  return JSON.stringify(mcpToolContractSchema.parse(left)) === JSON.stringify(mcpToolContractSchema.parse(right));
}

export function assertMcpToolContractMatches(
  expected: McpToolContractV1,
  actual: McpToolContractV1,
  toolName = expected.remoteToolName
): void {
  if (!mcpToolContractsEqual(expected, actual)) {
    throw new Error(`mcp_tool_contract_drift:${toolName}`);
  }
}

type JsonSchemaValue = null | string | number | boolean | JsonSchemaValue[] | { [key: string]: JsonSchemaValue };

function normalizeJsonSchemaValue(input: unknown, parentKey?: string): JsonSchemaValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error('mcp_tool_schema_not_json');
    }
    return input;
  }
  if (Array.isArray(input)) {
    const values = input.map((value) => normalizeJsonSchemaValue(value));
    if (parentKey === 'required' || parentKey === 'enum' || parentKey === 'type') {
      return values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return values;
  }
  if (!isRecord(input)) {
    throw new Error('mcp_tool_schema_not_json');
  }
  const normalized: { [key: string]: JsonSchemaValue } = {};
  for (const key of Object.keys(input).sort()) {
    normalized[key] = normalizeJsonSchemaValue(input[key], key);
  }
  return normalized;
}

function assertBytesBelow(value: string, maxBytes: number, errorCode: string): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(errorCode);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
