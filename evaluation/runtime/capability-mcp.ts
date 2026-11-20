import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeSync
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RocCapabilityRegistry } from '../../src/main/kernel/types';
import type { AgentMcpContractDiscoveryProvider } from '../../src/main/plugins/agent/runtime';
import { createMcpPlugin } from '../../src/main/plugins/mcp';
import { createMcpClientAdapter } from '../../src/main/plugins/mcp/mcp-client-adapter';
import { createMcpToolContract, readMcpToolContractMetadata } from '../../src/main/plugins/mcp/mcp-tool-contract';
import type { McpServerConfig, McpServerSnapshot, McpToolContractV1 } from '../../src/shared/types';
import { qualityHash } from './agent-task-view';

// Public runtime inputs only. This module never imports a dataset or verifier.
export const capabilityMcpEnvironmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal('local-records-v1'),
  sourceFile: z.literal('mcp-records.json')
});
export type CapabilityMcpEnvironment = z.infer<typeof capabilityMcpEnvironmentSchema>;
export const capabilityMcpServerId = 'evaluation-mcp';
export const capabilityMcpToolName = 'lookup_record';
export const capabilityMcpSourceMaxBytes = 32 * 1024;
const maxWireBytes = 4 * 1024 * 1024;
const maxMessageBytes = 64 * 1024;
const maxMessages = 512;
const description = 'Read the original public JSON value for a key in mcp-records.json.';
const inputSchema = {
  type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 128 } },
  required: ['key'], additionalProperties: false
};
const outputSchema = {
  type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 128 }, value: {} },
  required: ['key', 'value'], additionalProperties: false
};
const remoteTool = {
  name: capabilityMcpToolName, description, inputSchema, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};
const discoverParameters = { _meta: {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: '@roc/mcp-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
} };

// This preview is independently checked against actual tools/list discovery
// when Runtime starts a run. It supplies no execution evidence.
export function createCapabilityMcpToolContract(): McpToolContractV1 {
  return createMcpToolContract({
    serverId: capabilityMcpServerId, remoteToolName: capabilityMcpToolName,
    runtimeToolName: `${capabilityMcpServerId}_${capabilityMcpToolName}`, transport: 'stdio',
    inputSchema, outputSchema, description
  });
}

export function createCapabilityMcpServer(environment: unknown): McpServerSnapshot {
  capabilityMcpEnvironmentSchema.parse(environment);
  const node = realpathSync(process.execPath);
  // The production command parser understands quoted tokens, not shell escapes.
  if (/["\r\n]/u.test(node)) throw new Error('capability_mcp_node_command_invalid');
  return {
    id: capabilityMcpServerId, name: 'Evaluation public records', enabled: true,
    transport: 'stdio', preset: false, riskLevel: 'low', status: 'not_connected', tools: 1,
    allowedTools: [capabilityMcpToolName],
    command: `"${node}" application-worker.mjs --capability-mcp-peer`
  };
}

export type CapabilityMcpRuntime = {
  servers: McpServerSnapshot[];
  mcpContractDiscoveryProvider: AgentMcpContractDiscoveryProvider;
  close(): Promise<void>;
};

export function initializeCapabilityMcp(input: {
  environment?: unknown;
  capabilities: RocCapabilityRegistry;
  root: string;
}): CapabilityMcpRuntime {
  if (input.environment === undefined) {
    return { servers: [], mcpContractDiscoveryProvider: async () => [], close: async () => {} };
  }
  const environment = capabilityMcpEnvironmentSchema.parse(input.environment);
  const root = regularDirectory(input.root);
  if (root !== realpathSync(process.cwd())) throw new Error('capability_mcp_cwd_mismatch');
  const source = publicSource(root, environment);
  const state = join(root, 'mcp-state');
  // One initializer per worker. Reusing an old trial is an error, not an append.
  mkdirSync(state, { mode: 0o700 });
  durableFile(join(state, 'config.json'), Buffer.from(`${JSON.stringify(environment)}\n`));
  durableFile(join(state, 'source.json'), source);
  syncDirectory(state);
  syncDirectory(root);
  const servers = [createCapabilityMcpServer(environment)];
  const adapter = createMcpClientAdapter();
  const plugin = createMcpPlugin({ clientAdapter: adapter });
  for (const name of ['mcp.tools.get', 'mcp.tools.release'] as const) {
    const descriptor = plugin.manifest.capabilities.find(item => item.name === name);
    if (!descriptor) throw new Error('capability_mcp_descriptor_missing');
    input.capabilities.declare(plugin.manifest.id, descriptor);
    input.capabilities.register(plugin.manifest.id, descriptor, async value => {
      if (name === 'mcp.tools.release') {
        await adapter.release((value as { runId: string }).runId);
        return { released: true as const };
      }
      const request = value as { runId: string; servers: McpServerConfig[]; signal: AbortSignal };
      assertServers(request.servers, servers[0]);
      return await adapter.loadTools(request.runId, request.servers, request.signal);
    });
  }
  return {
    servers,
    mcpContractDiscoveryProvider: async ({ manifest }) => {
      assertServers(manifest.mcpServers, servers[0]);
      const discoveryId = `capability-mcp-discovery-${randomUUID()}`;
      try {
        const tools = await adapter.loadTools(discoveryId, manifest.mcpServers, AbortSignal.timeout(10_000));
        return tools.map(readMcpToolContractMetadata);
      } finally { await adapter.release(discoveryId); }
    },
    close: async () => { await adapter.close(); }
  };
}

function assertServers(actual: readonly McpServerConfig[], expected: McpServerSnapshot): void {
  const { status: _status, tools: _tools, ...config } = expected;
  if (actual.length !== 1 || qualityHash(actual[0]) !== qualityHash(config)) {
    throw new Error('capability_mcp_server_config_mismatch');
  }
}

function regularDirectory(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('capability_mcp_directory_invalid');
  const resolved = realpathSync(path);
  if (resolved !== path) throw new Error('capability_mcp_directory_link');
  return resolved;
}

function regularBytes(path: string, limit: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) {
    throw new Error('capability_mcp_file_invalid');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new Error('capability_mcp_source_replaced');
    }
    const raw = readFileSync(fd);
    if (raw.length !== stat.size || raw.length > limit) throw new Error('capability_mcp_file_size_invalid');
    return raw;
  } finally { closeSync(fd); }
}

function publicSource(root: string, environment: CapabilityMcpEnvironment): Buffer {
  const workspace = regularDirectory(join(root, 'workspace'));
  const raw = regularBytes(join(workspace, environment.sourceFile), capabilityMcpSourceMaxBytes);
  parseRecords(raw);
  return raw;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function parseRecords(raw: Buffer): Record<string, Json> {
  const value = strictJson(raw);
  if (!isObject(value)) throw new Error('capability_mcp_records_invalid');
  return value as Record<string, Json>;
}

function strictJson(raw: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const parsed: unknown = JSON.parse(text);
  let index = 0;
  const spaces = () => { while (index < text.length && /\s/u.test(text[index])) index++; };
  function string(): string {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') index++;
      else if (char === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new Error('capability_mcp_json_string_invalid');
  }
  function visit(depth: number): void {
    if (depth > 64) throw new Error('capability_mcp_json_depth');
    spaces();
    if (text[index] === '{') {
      index++; spaces();
      const keys = new Set<string>();
      if (text[index] !== '}') {
        while (true) {
          spaces();
          const key = string();
          if (keys.has(key)) throw new Error('capability_mcp_json_duplicate_key');
          keys.add(key); spaces(); index++; visit(depth + 1); spaces();
          if (text[index] !== ',') break;
          index++;
        }
      }
      index++;
    } else if (text[index] === '[') {
      index++; spaces();
      if (text[index] !== ']') {
        while (true) { visit(depth + 1); spaces(); if (text[index] !== ',') break; index++; }
      }
      index++;
    } else if (text[index] === '"') string();
    else {
      const start = index;
      while (index < text.length && !/[\s,\]}]/u.test(text[index])) index++;
      const value: unknown = JSON.parse(text.slice(start, index));
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('capability_mcp_json_nonfinite');
    }
  }
  visit(0); spaces();
  if (index !== text.length) throw new Error('capability_mcp_json_trailing_data');
  return parsed;
}

function durableFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function digest(raw: Buffer): string { return createHash('sha256').update(raw).digest('hex'); }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validArguments(value: unknown): value is { key: string } {
  return isObject(value) && Object.keys(value).length === 1 && typeof value.key === 'string'
    && value.key.length >= 1 && [...value.key].length <= 128;
}

// A real JSON-RPC stdio peer. Must be dispatched before application host input
// is read. Wire capture happens before replies leave stdout; the host verifier
// additionally requires the actual client result and production DB receipt.
export async function runCapabilityMcpPeer(): Promise<void> {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[method] = (...values: unknown[]) => { process.stderr.write(`${values.map(String).join(' ')}\n`); };
  }
  const root = regularDirectory(realpathSync(process.cwd()));
  const state = regularDirectory(join(root, 'mcp-state'));
  const environment = capabilityMcpEnvironmentSchema.parse(strictJson(regularBytes(join(state, 'config.json'), 4096)));
  const original = regularBytes(join(state, 'source.json'), capabilityMcpSourceMaxBytes);
  const source = publicSource(root, environment);
  if (!source.equals(original)) throw new Error('capability_mcp_source_changed');
  const peerId = randomUUID(), peer = join(state, `peer-${peerId}`);
  mkdirSync(peer, { mode: 0o700 });
  durableFile(join(peer, 'pid.json'), Buffer.from(`${JSON.stringify({
    schemaVersion: 1, serverId: capabilityMcpServerId, peerId, pid: process.pid, parentPid: process.ppid,
    executable: realpathSync(process.execPath), cwd: root, argv: process.argv.slice(1),
    sourceFile: environment.sourceFile, sourceSha256: digest(source), sourceJsonHash: qualityHash(parseRecords(source))
  })}\n`));
  const wireFd = openSync(join(peer, 'wire.jsonl'), 'wx', 0o600);
  fsyncSync(wireFd); syncDirectory(peer); syncDirectory(state);
  let sequence = 0, wireBytes = 0, closed = false, initialized = false, notified = false, probeOnly = false;
  let calls = 0;
  const requestIds = new Set<string>();
  function record(direction: 'in' | 'out', raw: Buffer): void {
    const bytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1, sequence: ++sequence, peerId, pid: process.pid, direction,
      bytes: raw.length, sha256: digest(raw), rawBase64: raw.toString('base64')
    })}\n`);
    wireBytes += bytes.length;
    if (sequence > maxMessages || wireBytes > maxWireBytes) throw new Error('capability_mcp_wire_limit');
    writeAll(wireFd, bytes); fsyncSync(wireFd);
  }
  function close(reason: string, clean: boolean): void {
    if (closed) return;
    closed = true;
    fsyncSync(wireFd); closeSync(wireFd);
    durableFile(join(peer, 'close.json'), Buffer.from(`${JSON.stringify({
      schemaVersion: 1, peerId, pid: process.pid, reason, clean, messages: sequence, calls
    })}\n`));
    syncDirectory(peer);
  }
  const onTerminate = () => { close('SIGTERM', true); process.exit(0); };
  process.once('SIGTERM', onTerminate);
  async function reply(id: unknown, body: { result: unknown } | { error: { code: number; message: string } }): Promise<void> {
    const raw = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
    if (raw.length > maxMessageBytes) throw new Error('capability_mcp_reply_limit');
    record('out', raw);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(raw, error => error ? reject(error) : resolve());
    });
  }
  async function receive(raw: Buffer): Promise<void> {
    record('in', raw);
    const request = strictJson(raw);
    if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      throw new Error('capability_mcp_request_invalid');
    }
    if (request.id === undefined) {
      if (request.method === 'notifications/initialized' && initialized && !notified) { notified = true; return; }
      if (request.method === 'notifications/cancelled') return;
      throw new Error('capability_mcp_notification_invalid');
    }
    if (typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isSafeInteger(request.id))) {
      throw new Error('capability_mcp_request_id_invalid');
    }
    const identity = JSON.stringify(request.id);
    if (requestIds.has(identity)) throw new Error('capability_mcp_request_id_duplicate');
    requestIds.add(identity);
    // The production SDK negotiates modern MCP on a disposable sibling process.
    // This peer implements legacy MCP, so an honest method-not-found response
    // lets the SDK close the probe and initialize its actual session.
    if (request.method === 'server/discover') {
      if (sequence !== 1 || request.id !== 'server-discover-probe-1'
        || qualityHash(request.params) !== qualityHash(discoverParameters)) {
        throw new Error('capability_mcp_probe_invalid');
      }
      probeOnly = true;
      await reply(request.id, { error: { code: -32601, message: 'Method not found' } });
      return;
    }
    if (probeOnly) throw new Error('capability_mcp_probe_session_invalid');
    if (request.method === 'initialize') {
      if (sequence !== 1 || initialized || !isObject(request.params) || typeof request.params.protocolVersion !== 'string') {
        throw new Error('capability_mcp_initialize_invalid');
      }
      initialized = true;
      await reply(request.id, { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: capabilityMcpServerId, version: '1.0.0' } } });
      return;
    }
    if (!initialized || !notified) throw new Error('capability_mcp_not_initialized');
    if (request.method === 'ping') { await reply(request.id, { result: {} }); return; }
    if (request.method === 'tools/list') { await reply(request.id, { result: { tools: [remoteTool] } }); return; }
    if (request.method !== 'tools/call') {
      await reply(request.id, { error: { code: -32601, message: 'Method not found' } }); return;
    }
    calls++;
    const params = request.params;
    if (!isObject(params) || params.name !== capabilityMcpToolName || !validArguments(params.arguments)) {
      await reply(request.id, { error: { code: -32602, message: 'Invalid lookup_record arguments' } }); return;
    }
    const current = publicSource(root, environment);
    if (!current.equals(original)) {
      await reply(request.id, { result: { isError: true,
        content: [{ type: 'text', text: 'capability_mcp_source_changed' }] } }); return;
    }
    const records = parseRecords(current), key = params.arguments.key;
    if (!Object.hasOwn(records, key)) {
      await reply(request.id, { result: { isError: true,
        content: [{ type: 'text', text: 'capability_mcp_record_not_found' }] } }); return;
    }
    const value = records[key];
    await reply(request.id, { result: {
      isError: false, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { key, value },
      // Protocol correlation only, retained by the production client as a
      // ToolMessage artifact. This is not a provider side-effect receipt.
      _meta: { evaluationMcp: { schemaVersion: 1, peerId, pid: process.pid, requestId: request.id } }
    } });
  }
  try {
    let pending = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline + 1 > maxMessageBytes) throw new Error('capability_mcp_request_limit');
        const raw = pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
        await receive(raw);
      }
      if (pending.length > maxMessageBytes) throw new Error('capability_mcp_request_limit');
    }
    if (pending.length) throw new Error('capability_mcp_request_incomplete');
    close('stdin-ended', true);
  } catch (error) {
    close('protocol-error', false);
    throw error;
  } finally { process.removeListener('SIGTERM', onTerminate); }
}
