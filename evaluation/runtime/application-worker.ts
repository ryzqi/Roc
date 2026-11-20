import { createInterface } from 'node:readline';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openExecutionGrantBroker } from '../../src/main/services/deep-agent/execution-grant-broker';
import { ChatOpenAI } from '@langchain/openai';
import { completionDelta } from './completion-delta';
import { applyAgentDatabaseSchema, applyMemoryDatabaseSchema } from '../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../src/main/kernel/capability-registry';
import { EventBus } from '../../src/main/kernel/event-bus';
import { AgentPluginRuntime, agentChatRunEventType } from '../../src/main/plugins/agent/runtime';
import { AgentSessionRepository } from '../../src/main/plugins/agent/session-repository';
import { AgentRunEventLog } from '../../src/main/plugins/agent/run-event-log';
import { createAgentDeepAgentExecutor } from '../../src/main/plugins/agent/deep-agent-executor';
import { createRunCapabilityManifestHash } from '../../src/main/plugins/agent/run-capability-manifest';
import { RunUsageLedger } from '../../src/main/services/deep-agent/run-usage-ledger';
import { AgentToolEffectStore } from '../../src/main/services/deep-agent/tool-effect-store';
import { RocSqliteCheckpointer } from '../../src/main/services/deep-agent/sqlite-checkpointer';
import { ContextArtifactStore } from '../../src/main/services/deep-agent/context/context-artifact-store';
import { RocSqliteStore } from '../../src/main/services/memory/sqlite-store';
import { MemoryStoreRepository } from '../../src/main/plugins/memory/memory-store-repository';
import { AgentMemoryStatsContract } from '../../src/main/plugins/agent/agent-memory-stats-contract';
import { AutoMemoryWriter } from '../../src/main/services/memory/auto-memory-writer';
import { AutoMemoryAuditRepository } from '../../src/main/services/memory/auto-memory-audit-repository';
import { RocPaths } from '../../src/main/services/paths';
import type { LangChainChatModelHandle } from '../../src/main/services/langchain-model-factory';
import { agentTaskViewSchema, applicationSessionSchema, qualityHash } from './agent-task-view';
import { benchmarkKindSchema, benchmarkManifest, benchmarkMode } from './benchmark-runtime';
import { capabilityMcpEnvironmentSchema, initializeCapabilityMcp, runCapabilityMcpPeer } from './capability-mcp';
import {getCapabilityOperationContext} from '../../src/main/kernel/capability-operation-context';
import {takeProposedResearchTool, type ProposedResearchTool} from './research-tool-correlation';
import {researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema} from '../../src/shared/schemas/research';
import {knowledgeContextRequestSchema, knowledgeContextResultSchema} from '../../src/shared/schemas/research-knowledge-context';
import { z } from 'zod';
import type { ExecutionGrantBinding } from '../../src/main/services/deep-agent/execution-grant-broker';

// stdout is exclusively the host protocol; application/library logging belongs to stderr.
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...values: unknown[]) => process.stderr.write(`${values.map(String).join(' ')}\n`);
}
if (process.argv.includes('--capability-mcp-peer')) {
  await runCapabilityMcpPeer();
  process.exit(0);
}
// No dataset, validator, reviewer, secret, or evaluator module is imported here.
const lines = createInterface({ input: process.stdin });
const iterator = lines[Symbol.asyncIterator]();
async function receive(): Promise<unknown> {
  const next = await iterator.next();
  if (next.done) throw new Error('quality_worker_host_closed');
  return JSON.parse(next.value);
}
function send(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
let exchangeTail: Promise<unknown> = Promise.resolve();
function exchange(value: unknown): Promise<unknown> {
  const result = exchangeTail.then(async () => {send(value); return await receive();});
  exchangeTail = result.catch(() => {});
  return result;
}
type WorkerInput = {
  view: unknown; providerId: string; modelId: string; temperature: number; contextWindowTokens: number;
  maxOutputTokens: number;
  isolationProbePaths: string[]; isolationProbePort: number | null;
  benchmark?: unknown;
  researchProjectId?: string;
  benchmarkToolNames?: string[];
  benchmarkRunMode?: 'task' | 'chat';
  session?: unknown;
  mcp?: unknown;
  captureInitialState?: boolean;
};
const input = await receive() as WorkerInput;
const view = agentTaskViewSchema.parse(input.view);
const benchmark = input.benchmark === undefined ? undefined : benchmarkKindSchema.parse(input.benchmark);
const session = input.session === undefined ? undefined : applicationSessionSchema.parse(input.session);
const mcp = input.mcp === undefined ? undefined : capabilityMcpEnvironmentSchema.parse(input.mcp);
if (session && (session.turns[0]?.prompt !== view.prompt || benchmark === undefined
  || !['roc-capability', 'roc-e2e-research', 'roc-security'].includes(benchmark))) {
  throw new Error('application_session_input_invalid');
}
let phase: { id: string; index: number; runId?: string; threadId?: string } | undefined;
const phaseBinding = () => phase === undefined ? {} : {
  schemaVersion: 2, phaseId: phase.id, phaseIndex: phase.index, runId: phase.runId, threadId: phase.threadId
};
if (input.isolationProbePaths.length > 0) {
  const denied = input.isolationProbePaths.every(path => {
    try { readFileSync(path); return false; } catch { return true; }
  });
  const child = spawnSync('/bin/cat', [input.isolationProbePaths[0]]);
  if (!denied || child.status === 0) throw new Error('quality_worker_isolation_probe_failed');
  send({ type: 'isolation', filesDenied: denied, childDenied: child.status !== 0 });
}
if (input.isolationProbePort !== null) {
  const denied = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: input.isolationProbePort! });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => {
      socket.destroy();
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(true);
      else reject(error);
    });
  });
  if (!denied) throw new Error('quality_worker_network_probe_failed');
  send({ type: 'isolation', networkDenied: denied });
}
const root = process.cwd();
const paths = new RocPaths(join(root, 'state'));
paths.ensureTree();
const db = new Database(join(root, 'agent.sqlite'));
applyAgentDatabaseSchema(db);
const memoryDb = new Database(join(root, 'memory.sqlite'));
applyMemoryDatabaseSchema(memoryDb);
const manifestBase = {
  schemaVersion: 1 as const, requestedCapabilities: { mcpServers: [], skills: [] },
  resolvedCapabilities: { mcpServers: [], skills: [] }, skippedCapabilities: [],
  tools: [], skills: [], mcpServers: [], untrustedContextPolicy: 'external_content_reference_only' as const
};
const manifest = benchmark === undefined ? { ...manifestBase, manifestHash: createRunCapabilityManifestHash(manifestBase) }
  : benchmarkManifest(benchmark, input.benchmarkToolNames, input.benchmarkRunMode, mcp);
const supportsResearch = manifest.tools.some(tool => tool.modelVisibleName.startsWith('research_'));
const supportsExecution = manifest.tools.some(tool => tool.modelVisibleName === 'run_shell_command');
const mode = benchmark === undefined ? 'chat' : benchmarkMode(benchmark, input.benchmarkToolNames, input.benchmarkRunMode);
const capabilities = new CapabilityRegistry();
const mcpRuntime = initializeCapabilityMcp({ environment: mcp, capabilities, root: realpathSync(root) });
const enabledCapabilities = { mcpServers: mcpRuntime.servers.map(server => server.id), skills: [] };
const broker = openExecutionGrantBroker(db);
const pendingTools: ProposedResearchTool[] = [];
const store = new RocSqliteStore(memoryDb);
const memoryRepository = new MemoryStoreRepository({
  store, agentFacts: new AgentMemoryStatsContract(db),
  getWorkspace: () => ({ path: join(root, 'workspace'), label: 'Evaluation workspace' }),
  auditRepository: new AutoMemoryAuditRepository(memoryDb)
});
const memoryWriter = new AutoMemoryWriter({
  repository: memoryRepository, auditRepository: new AutoMemoryAuditRepository(memoryDb),
  logger: { info: () => {}, error: (message: string) => console.error(message),
    warn: (message: string) => console.warn(message) }
});
for (const [name, invoke] of [
  ['memory.entries.search', (request: Parameters<MemoryStoreRepository['searchEntries']>[0]) => memoryRepository.searchEntries(request)],
  ['memory.entry.remember', (request: Parameters<AutoMemoryWriter['recordCandidate']>[0]) => memoryWriter.recordCandidate(request)]
] as const) {
  const descriptor = { name, version: '1.0.0', inputSchema: z.unknown(), outputSchema: z.unknown() };
  capabilities.declare('memory', descriptor);
  capabilities.register('memory', descriptor, request => invoke(request as never));
}
if (supportsResearch) {
  const projectId = input.researchProjectId;
  if (!projectId) throw new Error('benchmark_research_project_required');
  for (const [name, inputSchema, outputSchema] of [
    ['research.knowledge.search', researchKnowledgeSearchRequestSchema, researchKnowledgeSearchResultSchema],
    ['research.knowledge.context', knowledgeContextRequestSchema, knowledgeContextResultSchema]
  ] as const) {
    const descriptor = {name, version: '1.0.0', inputSchema, outputSchema};
    capabilities.declare('benchmark', descriptor);
    capabilities.register<unknown, unknown>('benchmark', descriptor, async request => {
      const operation = getCapabilityOperationContext();
      const tool = takeProposedResearchTool(pendingTools, {name, request, projectId, toolCallId: operation?.toolCallId});
      const response = await exchange({type: 'research', ...phaseBinding(), name, request, toolCallId: tool.id}) as {
        type: string; toolCallId: string; result: unknown;
      };
      if (response.type !== 'research_result' || response.toolCallId !== tool.id) throw new Error('benchmark_research_protocol');
      return response.result;
    });
  }
  const facts = {name: 'research.task.facts.forChat', version: '1.0.0', inputSchema: z.unknown(), outputSchema: z.null()};
  capabilities.declare('benchmark', facts);
  // These QA environments have no linked production research Task/fact snapshot.
  capabilities.register('benchmark', facts, async () => null);
}
if (supportsExecution) {
  const descriptor = { name: 'shell.executeAgent', version: '1.0.0', inputSchema: z.unknown(), outputSchema: z.unknown() };
  capabilities.declare('benchmark', descriptor);
  capabilities.register('benchmark', descriptor, async value => {
    const request = value as { grantId: string; binding: ExecutionGrantBinding; signal: AbortSignal };
    request.signal.throwIfAborted();
    const grant = broker.consume(request.grantId, request.binding);
    // The host executes only this fixed entry point in the local task sandbox.
    // Arbitrary host commands, extra arguments and alternative cwd are never forwarded.
    if (request.binding.command !== 'python solution.py' || grant.cwd !== join(root, 'workspace')) {
      throw new Error('benchmark_command_not_allowed');
    }
    const response = await exchange({ type: 'execute', ...phaseBinding(), command: 'python solution.py', grantId: grant.grantId,
      toolCallId: getCapabilityOperationContext()?.toolCallId,
      maxDurationMs: grant.maxDurationMs, maxOutputBytes: grant.maxOutputBytes }) as { type: string; result: unknown };
    if (response.type !== 'executed') throw new Error('benchmark_execution_protocol');
    return response.result;
  });
}
let requestCount = 0;
const model = new ChatOpenAI({
  model: input.modelId, apiKey: ['fixture', 'stdio'].join('-'), temperature: input.temperature,
  streaming: false, maxRetries: 0, maxTokens: input.maxOutputTokens,
  configuration: {
    baseURL: 'http://roc-evaluation.invalid/v1',
    fetch: async (_url, init) => {
      const original = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const { stream_options: _streamOptions, ...parameters } = original;
      const body = { ...parameters, stream: false };
      const reply = await exchange({ type: 'request', ...phaseBinding(), index: requestCount++, body, requestHash: qualityHash(body) }) as { type: string; body?: unknown };
      if (reply.type !== 'response') throw new Error('quality_worker_provider_failed');
      if (supportsResearch) {
        const response = reply.body as {choices?: Array<{message?: {tool_calls?: ProposedResearchTool[]}}>};
        pendingTools.push(...(response.choices?.[0]?.message?.tool_calls ?? []));
      }
      if (original.stream !== true) {
        return new Response(JSON.stringify(reply.body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // The application executor streams locally; the trusted host makes one bounded
      // non-streaming completion and this bridge presents its result as SDK chunks.
      const completion = reply.body as { id: string; created: number; model: string; usage: unknown;
        choices: Array<{ index: number; message: unknown; finish_reason: string }> };
      const chunk = { id: completion.id, object: 'chat.completion.chunk', created: completion.created,
        model: completion.model, choices: completion.choices.map(choice => ({
          index: choice.index, delta: completionDelta(choice.message), finish_reason: choice.finish_reason
        })) };
      const usage = { ...chunk, choices: [], usage: completion.usage };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  }
});
const runEventLog = new AgentRunEventLog(db);
const repository = new AgentSessionRepository(db, { runEventLog });
const sessionDescriptor = { name: 'agent.sessions.search', version: '1.0.0', inputSchema: z.unknown(), outputSchema: z.unknown() };
capabilities.declare('agent', sessionDescriptor);
capabilities.register('agent', sessionDescriptor, async request =>
  repository.searchSessionMessages(request as Parameters<AgentSessionRepository['searchSessionMessages']>[0]));
const handle: LangChainChatModelHandle = {
  model, modelId: input.modelId,
  provider: { id: input.providerId, name: 'Evaluation host', type: 'openai_compatible',
    enabled: true, models: [], endpoint: 'http://roc-evaluation.invalid/v1', credentialRef: null },
  runtime: { providerType: 'openai_compatible', baseUrl: null, streaming: false,
    modelKwargs: {}, contextWindowTokens: input.contextWindowTokens, maxOutputTokens: input.maxOutputTokens }
};
const eventBus = new EventBus({ error: (message, metadata) => {
  process.stderr.write(`${JSON.stringify({ message, metadata })}\n`);
} });
let resolveOutput: ((output: string) => void) | undefined;
let rejectOutput: ((error: Error) => void) | undefined;
eventBus.subscribe<{ type: string; runId: string; threadId?: string; assistantMessage?: string }>(agentChatRunEventType, event => {
  if (phase) {
    phase.runId ??= event.payload.runId;
    if (event.payload.threadId) phase.threadId ??= event.payload.threadId;
  }
  send({ type: 'event', ...phaseBinding(), event: event.payload });
  if (event.payload.type === 'run_completed' && typeof event.payload.assistantMessage === 'string') {
    resolveOutput?.(event.payload.assistantMessage);
  }
  if (event.payload.type === 'run_interrupted') rejectOutput?.(new Error('quality_worker_interrupted'));
});
eventBus.subscribe<{ error: string }>('agent.run.failed', event => rejectOutput?.(new Error(event.payload.error)));
const runtime = new AgentPluginRuntime({
  repository, eventBus, runEventLog, executionGrantBroker: openExecutionGrantBroker(db),
  ...(mcp === undefined ? {} : { mcpContractDiscoveryProvider: mcpRuntime.mcpContractDiscoveryProvider }),
  deepAgentExecutor: createAgentDeepAgentExecutor({
    executionGrantBroker: openExecutionGrantBroker(db),
    usageLedger: new RunUsageLedger(db), capabilities,
    checkpointer: new RocSqliteCheckpointer(db), contextArtifactStore: new ContextArtifactStore(db),
    paths, sessionHistory: repository, store, toolEffectStore: new AgentToolEffectStore(db)
  }),
  modelFactory: {
    createDefaultModelHandle: async () => ({ providerId: input.providerId, modelId: input.modelId, langChainHandle: handle }),
    createModelHandleByProviderAndModel: async () => ({ providerId: input.providerId, modelId: input.modelId, langChainHandle: handle })
  },
  ...(benchmark === undefined ? {} : { workspaceProvider: async () => ({ id: 'evaluation-workspace',
    path: join(root, 'workspace'), displayName: 'Evaluation workspace', lastOpenedAt: new Date().toISOString(), trustState: 'trusted' as const }) }),
  ...(!supportsResearch ? {} : {researchProjectProvider: async (projectId: string) => {
    if (projectId !== input.researchProjectId) throw new Error('research_project_not_found');
    return {workspacePath: join(root, 'workspace')};
  }}),
  capabilityPreviewProvider: async () => ({
    runnable: false, modelId: input.modelId, builtInTools: manifest.tools.map(tool => tool.modelVisibleName), toolCards: [], skillCards: [],
    subagents: [], interruptOn: {}, manifest, reason: 'No connected capabilities; evaluation host supplies the model.'
  })
});
try {
  const legacyPrompt = view.conversationTurns === undefined ? view.prompt
    : `${view.conversationTurns.map((turn, index) => `Prior user turn ${index + 1}:\n${turn}`).join('\n\n')}\n\nCurrent user turn:\n${view.prompt}`;
  const turns = session?.turns ?? [{ id: 'single', prompt: legacyPrompt, thread: 'new' as const, responseContract: view.responseContract }];
  if (input.captureInitialState === true) {
    const acknowledgement = await exchange({ type: 'runtime_ready', schemaVersion: 1,
      manifestHash: manifest.manifestHash }) as { type: string };
    if (acknowledgement.type !== 'runtime_retained') throw new Error('application_initial_state_protocol');
  }
  const completed: Array<{ id: string; index: number; runId: string; threadId: string; output: string;
    requestStart: number; requestEnd: number; checkpointId: string }> = [];
  let priorThread: string | undefined;
  for (const [index, turn] of turns.entries()) {
    phase = session ? { id: turn.id, index } : undefined;
    const requestStart = requestCount;
    if (session) {
      const acknowledgement = await exchange({ type: 'phase_begin', ...phaseBinding(), thread: turn.thread,
        inputHash: qualityHash(turn), requestStart }) as { type: string; phaseId: string };
      if (acknowledgement.type !== 'phase_ready' || acknowledgement.phaseId !== turn.id) throw new Error('application_phase_protocol');
    }
    const terminal = new Promise<string>((resolve, reject) => { resolveOutput = resolve; rejectOutput = reject; });
    const started = await runtime.startRun({ input: turn.prompt, mode, enabledCapabilities,
      ...(turn.thread === 'continue' ? { threadId: priorThread } : {}),
      ...(turn.responseContract === undefined ? {} : { responseContract: turn.responseContract }),
      ...(supportsResearch ? {researchProjectId: input.researchProjectId} : {}),
      ...(supportsExecution ? { taskSource: 'workbench' as const, shellAllowedCommands: ['python solution.py'] } : {}) });
    const run = repository.getRun(started.runId);
    if (run === null) throw new Error('quality_worker_run_missing');
    if (phase) { phase.runId = run.id; phase.threadId = run.threadId; }
    const output = await terminal;
    const checkpoint = db.prepare("SELECT checkpoint_id FROM langgraph_checkpoints WHERE thread_id=? AND checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1")
      .get(run.threadId) as { checkpoint_id: string } | undefined;
    if (!checkpoint) throw new Error('application_phase_checkpoint_missing');
    const current = { id: turn.id, index, runId: run.id, threadId: run.threadId, output,
      requestStart, requestEnd: requestCount, checkpointId: checkpoint.checkpoint_id };
    completed.push(current); priorThread = run.threadId;
    if (session) {
      const acknowledgement = await exchange({ type: 'phase_end', ...phaseBinding(), ...current,
        manifestHash: repository.getRunExecutionSnapshot(run.id).capabilityManifest.manifestHash }) as { type: string; phaseId: string };
      if (acknowledgement.type !== 'phase_retained' || acknowledgement.phaseId !== turn.id) throw new Error('application_phase_protocol');
    }
  }
  await runtime.shutdown();
  await mcpRuntime.close();
  const last = completed.at(-1)!;
  send({ type: 'result', ...(session ? { schemaVersion: 2, phaseId: last.id, phases: completed } : {}),
    output: last.output, requests: requestCount, runId: last.runId, threadId: last.threadId,
    manifestHash: repository.getRunExecutionSnapshot(last.runId).capabilityManifest.manifestHash });
} finally {
  await mcpRuntime.close();
  db.close();
  memoryDb.close();
  lines.close();
}
