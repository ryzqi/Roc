import { createInterface } from 'node:readline';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ChatOpenAI } from '@langchain/openai';
import { ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseCheckpointSaver, Checkpoint, CheckpointMetadata } from '@langchain/langgraph';
import { StoreBackend } from 'deepagents';
import { z } from 'zod';
import { applyAgentDatabaseSchema, applyMemoryDatabaseSchema, applyWorkspaceDatabaseSchema } from '../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../src/main/kernel/capability-registry';
import { EventBus } from '../../src/main/kernel/event-bus';
import type { CapabilityOperationReceipt } from '../../src/main/kernel/capability-operation-context';
import { AgentPluginRuntime, agentChatRunEventType } from '../../src/main/plugins/agent/runtime';
import { AgentSessionRepository } from '../../src/main/plugins/agent/session-repository';
import { AgentRunEventLog } from '../../src/main/plugins/agent/run-event-log';
import { createAgentDeepAgentExecutor } from '../../src/main/plugins/agent/deep-agent-executor';
import { compileRunCapabilityManifest, createRunCapabilityManifestHash } from '../../src/main/plugins/agent/run-capability-manifest';
import { createWorkspacePlugin } from '../../src/main/plugins/workspace';
import { createMcpPlugin } from '../../src/main/plugins/mcp';
import { createMcpClientAdapter } from '../../src/main/plugins/mcp/mcp-client-adapter';
import { readMcpToolContractMetadata } from '../../src/main/plugins/mcp/mcp-tool-contract';
import { createRuntimeToolsPlugin } from '../../src/main/plugins/runtime-tools';
import { createShellExecutionService } from '../../src/main/plugins/runtime-tools/shell-adapter';
import { FileService } from '../../src/main/services/file-service';
import { WorkspaceService } from '../../src/main/services/workspace-service';
import { openExecutionGrantBroker, type ExecutionGrantBinding } from '../../src/main/services/deep-agent/execution-grant-broker';
import { RunUsageLedger } from '../../src/main/services/deep-agent/run-usage-ledger';
import { AgentToolEffectStore, type ToolEffectLease } from '../../src/main/services/deep-agent/tool-effect-store';
import { RocSqliteCheckpointer } from '../../src/main/services/deep-agent/sqlite-checkpointer';
import { ContextArtifactStore } from '../../src/main/services/deep-agent/context/context-artifact-store';
import { RocSqliteStore } from '../../src/main/services/memory/sqlite-store';
import { RocPaths } from '../../src/main/services/paths';
import { RtkService } from '../../src/main/services/rtk-service';
import type { LangChainChatModelHandle } from '../../src/main/services/langchain-model-factory';
import type { ChatResumeRunRequest, McpServerConfig, McpServerSnapshot } from '../../src/shared/types';
import { completionDelta } from './completion-delta';

// The host controls faults and model replies. No case truth or verifier imports.
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...values: unknown[]) => process.stderr.write(`${values.map(String).join(' ')}\n`);
}
function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function durableFile(path: string, content: string, flag = 'w'): void {
  const fd = openSync(path, flag, 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
async function runMcpServer(): Promise<void> {
  const mode = z.enum(['mcp-disconnect', 'mcp-receipt-lost']).parse(process.argv[3]);
  const state = z.string().min(1).parse(process.argv[4]);
  // This is a real JSON-RPC stdio peer. It never synthesizes a receipt for a
  // response the production MCP client did not receive.
  const audit = (value: unknown) => {
    const fd = openSync(join(state, 'transport.jsonl'), 'a', 0o600);
    try { appendFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const sendRpc = (id: string | number, result: unknown) => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id, result });
    audit({ event: 'wire', direction: 'out', raw, pid: process.pid });
    process.stdout.write(raw + '\n');
  };
  audit({ event: 'started', mode, pid: process.pid });
  const serverLines = createInterface({ input: process.stdin });
  try {
    for await (const raw of serverLines) {
      const request = z.object({
        jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(),
        method: z.string(), params: z.unknown().optional()
      }).parse(JSON.parse(raw));
      audit({ event: 'wire', direction: 'in', raw, pid: process.pid });
      if (request.id === undefined) continue;
      if (request.method === 'initialize') {
        const params = z.object({ protocolVersion: z.string() }).passthrough().parse(request.params);
        sendRpc(request.id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'roc-harness-local-transport', version: '1' } });
      } else if (request.method === 'tools/list') {
        sendRpc(request.id, { tools: [{ name: 'probe', description: 'Observe a controlled local external operation.',
          inputSchema: { type: 'object', properties: { requestId: { type: 'string' } },
            required: ['requestId'], additionalProperties: false } }] });
      } else if (request.method === 'tools/call') {
        const params = z.object({ name: z.literal('probe'),
          arguments: z.object({ requestId: z.string().min(1) }).strict() }).parse(request.params);
        if (mode === 'mcp-disconnect') {
          audit({ event: 'disconnected', rpcId: request.id, args: params.arguments, pid: process.pid });
          process.exit(19);
        }
        const bytes = `${JSON.stringify({ requestId: params.arguments.requestId, effect: 'committed' })}\n`;
        durableFile(join(state, 'remote-effect.json'), bytes, 'wx');
        syncDirectory(state);
        audit({ event: 'effect-committed', rpcId: request.id, args: params.arguments,
          sha256: sha256(bytes), bytes: Buffer.byteLength(bytes), pid: process.pid });
        // Publish a marker only after both the external bytes and audit are
        // fsynced. The worker's crash follows this observation, not a fake
        // tool result or a clock-based guess about dispatch.
        durableFile(join(state, 'commit.tmp'), JSON.stringify({ sha256: sha256(bytes) }));
        renameSync(join(state, 'commit.tmp'), join(state, 'commit-observed.json'));
        syncDirectory(state);
        // Deliberately withhold the tools/call reply; wait for process reaping.
      } else if (request.method === 'ping') sendRpc(request.id, {});
      else throw new Error(`harness_mcp_method_unsupported:${request.method}`);
    }
  } finally { serverLines.close(); }
}
if (process.argv[2] === '--harness-mcp-server') {
  await runMcpServer();
  process.exit(0);
}
const lines = createInterface({ input: process.stdin });
const iterator = lines[Symbol.asyncIterator]();
async function receive(): Promise<unknown> {
  const next = await iterator.next();
  if (next.done) throw new Error('harness_host_closed');
  return JSON.parse(next.value);
}
function send(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
const input = z.object({
  phase: z.enum(['start', 'recover']), prompt: z.string(), tools: z.array(z.string()),
  fault: z.enum(['none', 'model-pending', 'before-dispatch', 'receipt-durable', 'result-stored',
    'approval-expired', 'memory-db-error', 'mcp-disconnect', 'mcp-receipt-lost', 'context-compacted']),
  protectedPath: z.string(), runId: z.string().optional(), mcp: z.boolean().default(false),
  memorySeed: z.object({ key: z.literal('/MEMORY.md'), content: z.string().min(1) }).optional()
}).parse(await receive());
try { readFileSync(input.protectedPath); throw new Error('harness_isolation_failed'); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EPERM' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
  send({ type: 'isolation', protectedFileDenied: true });
}

const root = process.cwd();
const db = new Database(join(root, 'agent.sqlite'));
applyAgentDatabaseSchema(db);
const memory = new Database(join(root, 'memory.sqlite'));
applyMemoryDatabaseSchema(memory);
const workspaceDb = new Database(join(root, 'workspace.sqlite'));
applyWorkspaceDatabaseSchema(workspaceDb);
const paths = new RocPaths(join(root, 'state')); paths.ensureTree();
const store = new RocSqliteStore(memory);
if (input.phase === 'start' && input.memorySeed) {
  const seeded = await new StoreBackend({ store, namespace: ['roc', 'memory', 'global'] })
    .write(input.memorySeed.key, input.memorySeed.content);
  if (seeded.error !== undefined) throw new Error(`harness_memory_seed_failed:${seeded.error}`);
}
if (input.phase === 'start' && input.fault === 'memory-db-error') {
  memory.exec(`CREATE TRIGGER harness_memory_insert_error BEFORE INSERT ON langgraph_store_items
    BEGIN SELECT RAISE(ABORT, 'harness_memory_persistence_failed'); END;
    CREATE TRIGGER harness_memory_update_error BEFORE UPDATE ON langgraph_store_items
    BEGIN SELECT RAISE(ABORT, 'harness_memory_persistence_failed'); END;`);
  send({ type: 'memory-fault', database: 'memory.sqlite', installed: true });
}
const workspaceService = new WorkspaceService();
workspaceService.selectWorkspace(join(root, 'workspace'));
const fileService = new FileService(paths, { db: workspaceDb }, workspaceService);
const capabilities = new CapabilityRegistry();
const workspacePlugin = createWorkspacePlugin();
const deleteDescriptor = workspacePlugin.manifest.capabilities.find(capability => capability.name === 'files.delete');
if (!deleteDescriptor) throw new Error('harness_delete_descriptor_missing');
capabilities.declare(workspacePlugin.manifest.id, deleteDescriptor);
capabilities.register(workspacePlugin.manifest.id, deleteDescriptor,
  async input => await fileService.deleteFile((input as { relativePath: string }).relativePath));
const runEventLog = new AgentRunEventLog(db);
const repository = new AgentSessionRepository(db, { runEventLog });
const ledger = new RunUsageLedger(db);
let clockMs = Date.now();
const broker = openExecutionGrantBroker(db, () => new Date(clockMs));
const contextArtifacts = new ContextArtifactStore(db);
class FaultCheckpointer extends RocSqliteCheckpointer {
  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata,
    versions: Parameters<BaseCheckpointSaver['put']>[3]): Promise<RunnableConfig> {
    const stored = await super.put(config, checkpoint, metadata, versions);
    if (input.phase === 'start' && input.fault === 'context-compacted') {
      const messages: unknown = checkpoint.channel_values.messages;
      if (Array.isArray(messages) && messages.some(message => ToolMessage.isInstance(message)
        && typeof message.content === 'string' && message.content.includes('<roc_context_artifact>'))
        && db.prepare('SELECT 1 FROM context_artifacts LIMIT 1').get() !== undefined) crash(input.fault);
    }
    return stored;
  }
}
const checkpointer = new FaultCheckpointer(db);
if (input.tools.includes('run_trusted_host_command')) {
  const plugin = createRuntimeToolsPlugin();
  const shell = createShellExecutionService({ workspaceService, rtkService: new RtkService(paths) });
  for (const name of ['shell.approveTrustedHost', 'shell.executeAgent']) {
    const descriptor = plugin.manifest.capabilities.find(item => item.name === name);
    if (!descriptor) throw new Error('harness_shell_descriptor_missing');
    capabilities.declare(plugin.manifest.id, descriptor);
    if (name === 'shell.approveTrustedHost') {
      capabilities.register(plugin.manifest.id, descriptor, async value => {
        const { binding } = value as { binding: ExecutionGrantBinding };
        send({ type: 'trusted-approval', binding });
        const decision = z.object({ type: z.literal('trusted-decision'), approved: z.literal(true) }).parse(await receive());
        const issuedAtMs = clockMs;
        const approvalReference = broker.recordTrustedHostApproval(binding);
        if (input.fault === 'approval-expired') clockMs += 30_001;
        send({ type: 'approval-clock', approvalReference, issuedAtMs, observedAtMs: clockMs });
        return { confirmed: decision.approved, approvalReference };
      });
    } else {
      capabilities.register(plugin.manifest.id, descriptor, async value => {
        const request = value as { grantId: string; binding: ExecutionGrantBinding; signal?: AbortSignal };
        const grant = broker.consume(request.grantId, request.binding);
        return await shell.executeGrantedAgentAsync({ command: request.binding.command, signal: request.signal, grant });
      });
    }
  }
}
const mcpAdapter = createMcpClientAdapter();
const mcpState = join(root, 'mcp-state');
const mcpServers: McpServerSnapshot[] = input.mcp ? [{
  id: 'harness', name: 'Controlled local transport', enabled: true, transport: 'stdio',
  preset: false, riskLevel: 'medium', allowedTools: ['probe'], status: 'ready', tools: 1,
  command: `${JSON.stringify(realpathSync(process.execPath))} ${JSON.stringify(join(root, 'harness-worker.mjs'))} --harness-mcp-server ${input.fault} ${JSON.stringify(mcpState)}`
}] : [];
if (input.mcp) {
  mkdirSync(mcpState, { recursive: true, mode: 0o700 });
  const plugin = createMcpPlugin({ clientAdapter: mcpAdapter });
  for (const name of ['mcp.tools.get', 'mcp.tools.release']) {
    const descriptor = plugin.manifest.capabilities.find(item => item.name === name);
    if (!descriptor) throw new Error('harness_mcp_descriptor_missing');
    capabilities.declare(plugin.manifest.id, descriptor);
    capabilities.register(plugin.manifest.id, descriptor, async value => {
      if (name === 'mcp.tools.release') {
        await mcpAdapter.release((value as { runId: string }).runId);
        return { released: true as const };
      }
      const request = value as { runId: string; servers: McpServerConfig[]; signal: AbortSignal };
      return await mcpAdapter.loadTools(request.runId, request.servers, request.signal);
    });
  }
}
const compiled = compileRunCapabilityManifest({
  mode: 'task', deleteFileApprovalMode: 'default', mcpApprovalMode: 'fully_automatic',
  mcpServers, skills: [], workflowHint: null, trustedHostAvailable: input.tools.includes('run_trusted_host_command'),
  requestedCapabilities: { mcpServers: mcpServers.map(server => server.id), skills: [] }
});
const { manifestHash: _manifestHash, ...manifestBase } = compiled.manifest;
const narrowed = { ...manifestBase, tools: manifestBase.tools.filter(tool => input.tools.includes(tool.modelVisibleName)) };
if (narrowed.tools.length !== input.tools.length) throw new Error('harness_tool_selection_invalid');
const manifest = { ...narrowed, manifestHash: createRunCapabilityManifestHash(narrowed) };
function crash(fault: typeof input.fault): void {
  send({ type: 'boundary', fault });
  process.exit(73);
}
const mcpCommitDeadline = Date.now() + 25_000;
const mcpCommitPoll = input.phase === 'start' && input.fault === 'mcp-receipt-lost' ? setInterval(() => {
  if (Date.now() >= mcpCommitDeadline) throw new Error('harness_mcp_commit_observation_timeout');
  const markerPath = join(mcpState, 'commit-observed.json');
  if (!existsSync(markerPath)) return;
  const marker = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
    .parse(JSON.parse(readFileSync(markerPath, 'utf8')));
  const actual = readFileSync(join(mcpState, 'remote-effect.json'));
  if (sha256(actual) !== marker.sha256) throw new Error('harness_mcp_commit_observation_invalid');
  send({ type: 'mcp-commit-observed', sha256: marker.sha256, bytes: actual.length });
  crash(input.fault);
}, 20) : undefined;
class FaultEffectStore extends AgentToolEffectStore {
  override markStarted(lease: ToolEffectLease): void {
    if (input.phase === 'start' && input.fault === 'before-dispatch') crash(input.fault);
    super.markStarted(lease);
  }
  override recordReceipt(lease: ToolEffectLease, receipt: CapabilityOperationReceipt): void {
    super.recordReceipt(lease, receipt);
    if (input.phase === 'start' && input.fault === 'receipt-durable'
      && receipt.kind === 'workspace_write' && receipt.phase === 'durable') crash(input.fault);
  }
  override finishSuccess(lease: ToolEffectLease, result: unknown): void {
    super.finishSuccess(lease, result);
    if (input.phase === 'start' && input.fault === 'result-stored') crash(input.fault);
  }
}
let runtime: AgentPluginRuntime;
let activeRunId: string | undefined;
let observedRunId: string | undefined;
let observedRunEventSequence = 0;
function observeRunEvents(runId: string, source: 'run-event-log' | 'startup-reconciliation'): void {
  if (observedRunId !== undefined && observedRunId !== runId) throw new Error('harness_observed_run_changed');
  observedRunId = runId;
  for (const entry of runEventLog.listRunEvents({ runId, afterSequence: observedRunEventSequence })) {
    if (entry.sequence !== observedRunEventSequence + 1) throw new Error('harness_observed_event_sequence_gap');
    send({ type: 'event', event: entry.event,
      persisted: { source, runId: entry.runId, sequence: entry.sequence, createdAt: entry.createdAt } });
    observedRunEventSequence = entry.sequence;
  }
}
let requestCount = 0;
const model = new ChatOpenAI({
  model: 'roc-harness-scripted', apiKey: ['fixture', 'harness'].join('-'), temperature: 0,
  maxRetries: 0, maxTokens: 512,
  configuration: { baseURL: 'http://roc-harness.invalid/v1', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    send({ type: 'request', index: requestCount++, body });
    if (input.phase === 'start' && input.fault === 'model-pending') crash(input.fault);
    const reply = z.discriminatedUnion('type', [
      z.object({ type: z.literal('response'), body: z.object({
        id: z.string(), created: z.number(), model: z.string(), usage: z.unknown(),
        choices: z.array(z.object({ index: z.number(), message: z.unknown(), finish_reason: z.string() }))
      }) }),
      z.object({ type: z.literal('cancel') }),
      z.object({ type: z.literal('response-error'), status: z.literal(503), message: z.string().min(1) })
    ]).parse(await receive());
    if (reply.type === 'cancel') {
      if (activeRunId === undefined) throw new Error('harness_cancel_run_missing');
      const signal = init?.signal;
      if (!signal) throw new Error('harness_model_signal_missing');
      const aborted = new Promise<Response>((_resolve, reject) => {
        const abort = () => { send({ type: 'model-aborted' }); reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
      void runtime.cancelRun({ runId: activeRunId }).then(result => send({ type: 'cancelled', result }));
      return await aborted;
    }
    if (reply.type === 'response-error') {
      send({ type: 'model-transport-error', index: requestCount - 1, status: reply.status });
      return new Response(JSON.stringify({ error: { message: reply.message, type: 'server_error', code: 'harness_transport_error' } }),
        { status: reply.status, headers: { 'content-type': 'application/json' } });
    }
    if (body.stream !== true) return new Response(JSON.stringify(reply.body), {
      headers: { 'content-type': 'application/json' }
    });
    const chunk = { id: reply.body.id, object: 'chat.completion.chunk', created: reply.body.created,
      model: reply.body.model, choices: reply.body.choices.map(choice => ({
        index: choice.index, delta: completionDelta(choice.message), finish_reason: choice.finish_reason
      })) };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({
      ...chunk, choices: [], usage: reply.body.usage
    })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } }
});
const handle: LangChainChatModelHandle = {
  model, modelId: 'roc-harness-scripted',
  provider: { id: 'roc-harness-local', name: 'Controlled local harness provider', type: 'openai_compatible',
    enabled: true, models: [], endpoint: 'http://roc-harness.invalid/v1', credentialRef: null },
  runtime: { providerType: 'openai_compatible', baseUrl: null, streaming: false, modelKwargs: {},
    contextWindowTokens: 65536, maxOutputTokens: 512 }
};
type Terminal = { status: 'completed' | 'failed' | 'waiting_user' | 'cancelled'; output?: string; error?: string };
const pending: Terminal[] = [];
let waiter: ((value: Terminal) => void) | undefined;
function publish(value: Terminal): void {
  if (waiter) { const resolve = waiter; waiter = undefined; resolve(value); }
  else pending.push(value);
}
function terminal(): Promise<Terminal> {
  const value = pending.shift();
  return value ? Promise.resolve(value) : new Promise(resolve => { waiter = resolve; });
}
const eventBus = new EventBus({ error: (message, metadata) => send({ type: 'bus-error', message, metadata }) });
eventBus.subscribe<{ type: string; runId: string }>(agentChatRunEventType, event => {
  // Preserve the actual notification order too. Failed/cancelled transitions
  // atomically persist their terminal row before publishing task acceptance.
  // Read committed rows separately, in their real database sequence order.
  send({ type: 'event-bus', event: event.payload });
  observeRunEvents(event.payload.runId, 'run-event-log');
  if (event.payload.type === 'run_interrupted') publish({ status: 'waiting_user' });
  if (event.payload.type === 'run_cancelled') publish({ status: 'cancelled' });
});
eventBus.subscribe('agent.run.task-event', event => send({ type: 'task-event', event: event.payload }));
eventBus.subscribe<{ assistantMessage: string }>('agent.run.completed', event =>
  publish({ status: 'completed', output: event.payload.assistantMessage }));
eventBus.subscribe<{ error: string }>('agent.run.failed', event =>
  publish({ status: 'failed', error: event.payload.error }));
runtime = new AgentPluginRuntime({
  repository, eventBus, runEventLog, executionGrantBroker: broker,
  deepAgentExecutor: createAgentDeepAgentExecutor({
    executionGrantBroker: broker, usageLedger: ledger,
    capabilities, checkpointer, contextArtifactStore: contextArtifacts,
    paths, sessionHistory: repository, store, toolEffectStore: new FaultEffectStore(db)
  }),
  modelFactory: {
    createDefaultModelHandle: async () => ({ providerId: handle.provider.id, modelId: handle.modelId, langChainHandle: handle }),
    createModelHandleByProviderAndModel: async () => ({ providerId: handle.provider.id, modelId: handle.modelId, langChainHandle: handle })
  },
  workspaceProvider: async () => workspaceService.requireWorkspace(),
  mcpContractDiscoveryProvider: async ({ manifest }) => {
    const discoveryId = `harness-discovery-${randomUUID()}`;
    try {
      const tools = await mcpAdapter.loadTools(discoveryId, manifest.mcpServers, AbortSignal.timeout(10_000));
      return tools.map(readMcpToolContractMetadata);
    } finally { await mcpAdapter.release(discoveryId); }
  },
  capabilityPreviewProvider: async () => ({
    runnable: false, modelId: handle.modelId, builtInTools: input.tools, toolCards: [], skillCards: [],
    subagents: [], interruptOn: compiled.interruptOn, manifest, reason: 'Controlled local harness provider.'
  })
});

try {
  if (input.phase === 'start') {
    const started = await runtime.startRun({ input: input.prompt, mode: 'task',
      enabledCapabilities: { mcpServers: mcpServers.map(server => server.id), skills: [] } });
    activeRunId = started.runId;
    send({ type: 'started', ...started, manifestHash: manifest.manifestHash });
  } else {
    if (!input.runId) throw new Error('harness_recovery_run_missing');
    activeRunId = input.runId;
    const afterSequence = runEventLog.listRunEvents({ runId: activeRunId, afterSequence: 0 }).at(-1)?.sequence ?? 0;
    observedRunEventSequence = afterSequence;
    const reconciled = repository.reconcileStartupRuns();
    ledger.reconcileStartup();
    // Startup reconciliation persists events without publishing on EventBus.
    // Observe its actual committed rows before the resumed runtime emits more.
    const persisted = runEventLog.listRunEvents({ runId: activeRunId, afterSequence });
    observeRunEvents(activeRunId, 'startup-reconciliation');
    const run = repository.getRun(activeRunId);
    send({ type: 'reconciled', runs: reconciled, runId: run.id, threadId: run.threadId,
      checkpointPresent: repository.hasCheckpoint(run.id), afterSequence,
      throughSequence: persisted.at(-1)?.sequence ?? afterSequence, eventsObserved: persisted.length });
    try {
      await runtime.resumeRun({ kind: 'checkpoint', runId: run.id, threadId: run.threadId });
    } catch (error) {
      send({ type: 'result', status: 'blocked', error: error instanceof Error ? error.message : String(error),
        runId: run.id, threadId: run.threadId, requests: requestCount });
      await runtime.shutdown();
      await mcpAdapter.close();
      if (mcpCommitPoll) clearInterval(mcpCommitPoll);
      process.exitCode = 0;
      db.close(); memory.close(); workspaceDb.close(); lines.close();
      // A blocked recovery is a complete observation, not a fabricated success.
      process.exit(0);
    }
  }
  let result = await terminal();
  let approvalRequest: ChatResumeRunRequest | undefined;
  if (result.status === 'waiting_user') {
    const run = repository.getRun(activeRunId!);
    const { interrupts } = repository.interruptProjection.readPending({ runId: run.id, threadId: run.threadId });
    if (interrupts.length !== 1 || interrupts[0].payload.kind !== 'approval') throw new Error('harness_approval_missing');
    send({ type: 'approval', interrupts, runId: run.id, threadId: run.threadId });
    // The host snapshots persisted state and bytes before releasing this decision.
    const decision = z.object({ type: z.literal('decision'), decision: z.enum(['approve', 'reject']) }).parse(await receive());
    approvalRequest = { kind: 'approval', runId: run.id, threadId: run.threadId,
      interruptId: interrupts[0].interruptId, decisions: [decision.decision === 'approve'
        ? { type: 'approve' } : { type: 'reject', message: 'Keep the file.' }] };
    await runtime.resumeRun(approvalRequest);
    result = await terminal();
  }
  let repeatedDecisionError: string | null = null;
  if (approvalRequest && result.status === 'completed') {
    try { await runtime.resumeRun(approvalRequest); }
    catch (error) { repeatedDecisionError = error instanceof Error ? error.message : String(error); }
  }
  let repeatedResumeError: string | null = null;
  if (input.phase === 'recover' && result.status === 'completed') {
    const run = repository.getRun(activeRunId!);
    try { await runtime.resumeRun({ kind: 'checkpoint', runId: run.id, threadId: run.threadId }); }
    catch (error) { repeatedResumeError = error instanceof Error ? error.message : String(error); }
  }
  await runtime.shutdown();
  send({ type: 'result', ...result, runId: activeRunId, requests: requestCount, repeatedResumeError, repeatedDecisionError });
} finally {
  if (mcpCommitPoll) clearInterval(mcpCommitPoll);
  await mcpAdapter.close();
  if (db.open) db.close();
  if (memory.open) memory.close();
  if (workspaceDb.open) workspaceDb.close();
  lines.close();
}
