import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ChatOpenAI } from '@langchain/openai';
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
import { FileService } from '../../src/main/services/file-service';
import { WorkspaceService } from '../../src/main/services/workspace-service';
import { openExecutionGrantBroker } from '../../src/main/services/deep-agent/execution-grant-broker';
import { RunUsageLedger } from '../../src/main/services/deep-agent/run-usage-ledger';
import { AgentToolEffectStore, type ToolEffectLease } from '../../src/main/services/deep-agent/tool-effect-store';
import { RocSqliteCheckpointer } from '../../src/main/services/deep-agent/sqlite-checkpointer';
import { ContextArtifactStore } from '../../src/main/services/deep-agent/context/context-artifact-store';
import { RocSqliteStore } from '../../src/main/services/memory/sqlite-store';
import { RocPaths } from '../../src/main/services/paths';
import type { LangChainChatModelHandle } from '../../src/main/services/langchain-model-factory';
import type { ChatResumeRunRequest } from '../../src/shared/types';
import { completionDelta } from './completion-delta';

// The host controls faults and model replies. No case truth or verifier imports.
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...values: unknown[]) => process.stderr.write(`${values.map(String).join(' ')}\n`);
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
  fault: z.enum(['none', 'model-pending', 'before-dispatch', 'receipt-durable', 'result-stored']),
  protectedPath: z.string(), runId: z.string().optional()
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
const checkpointer = new RocSqliteCheckpointer(db);
const compiled = compileRunCapabilityManifest({
  mode: 'task', deleteFileApprovalMode: 'default', mcpApprovalMode: 'default',
  mcpServers: [], skills: [], workflowHint: null,
  requestedCapabilities: { mcpServers: [], skills: [] }
});
const { manifestHash: _manifestHash, ...manifestBase } = compiled.manifest;
const narrowed = { ...manifestBase, tools: manifestBase.tools.filter(tool => input.tools.includes(tool.modelVisibleName)) };
if (narrowed.tools.length !== input.tools.length) throw new Error('harness_tool_selection_invalid');
const manifest = { ...narrowed, manifestHash: createRunCapabilityManifestHash(narrowed) };
function crash(fault: typeof input.fault): void {
  send({ type: 'boundary', fault });
  process.exit(73);
}
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
      z.object({ type: z.literal('cancel') })
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
eventBus.subscribe<{ type: string }>(agentChatRunEventType, event => {
  send({ type: 'event', event: event.payload });
  if (event.payload.type === 'run_interrupted') publish({ status: 'waiting_user' });
  if (event.payload.type === 'run_cancelled') publish({ status: 'cancelled' });
});
eventBus.subscribe('agent.run.task-event', event => send({ type: 'task-event', event: event.payload }));
eventBus.subscribe<{ assistantMessage: string }>('agent.run.completed', event =>
  publish({ status: 'completed', output: event.payload.assistantMessage }));
eventBus.subscribe<{ error: string }>('agent.run.failed', event =>
  publish({ status: 'failed', error: event.payload.error }));
runtime = new AgentPluginRuntime({
  repository, eventBus, runEventLog, executionGrantBroker: openExecutionGrantBroker(db),
  deepAgentExecutor: createAgentDeepAgentExecutor({
    executionGrantBroker: openExecutionGrantBroker(db), usageLedger: ledger,
    capabilities, checkpointer, contextArtifactStore: new ContextArtifactStore(db),
    paths, sessionHistory: repository, store: new RocSqliteStore(memory), toolEffectStore: new FaultEffectStore(db)
  }),
  modelFactory: {
    createDefaultModelHandle: async () => ({ providerId: handle.provider.id, modelId: handle.modelId, langChainHandle: handle }),
    createModelHandleByProviderAndModel: async () => ({ providerId: handle.provider.id, modelId: handle.modelId, langChainHandle: handle })
  },
  workspaceProvider: async () => workspaceService.requireWorkspace(),
  capabilityPreviewProvider: async () => ({
    runnable: false, modelId: handle.modelId, builtInTools: input.tools, toolCards: [], skillCards: [],
    subagents: [], interruptOn: compiled.interruptOn, manifest, reason: 'Controlled local harness provider.'
  })
});

try {
  if (input.phase === 'start') {
    const started = await runtime.startRun({ input: input.prompt, mode: 'task',
      enabledCapabilities: { mcpServers: [], skills: [] } });
    activeRunId = started.runId;
    send({ type: 'started', ...started, manifestHash: manifest.manifestHash });
  } else {
    if (!input.runId) throw new Error('harness_recovery_run_missing');
    activeRunId = input.runId;
    const reconciled = repository.reconcileStartupRuns();
    ledger.reconcileStartup();
    const run = repository.getRun(activeRunId);
    send({ type: 'reconciled', runs: reconciled, runId: run.id, threadId: run.threadId,
      checkpointPresent: repository.hasCheckpoint(run.id) });
    try {
      await runtime.resumeRun({ kind: 'checkpoint', runId: run.id, threadId: run.threadId });
    } catch (error) {
      send({ type: 'result', status: 'blocked', error: error instanceof Error ? error.message : String(error),
        runId: run.id, threadId: run.threadId, requests: requestCount });
      await runtime.shutdown();
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
  if (db.open) db.close();
  if (memory.open) memory.close();
  if (workspaceDb.open) workspaceDb.close();
  lines.close();
}
