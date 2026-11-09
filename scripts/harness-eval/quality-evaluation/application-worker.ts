import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openExecutionGrantBroker } from '../../../src/main/services/deep-agent/execution-grant-broker';
import { ChatOpenAI } from '@langchain/openai';
import { applyAgentDatabaseSchema, applyMemoryDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';
import { CapabilityRegistry } from '../../../src/main/kernel/capability-registry';
import { EventBus } from '../../../src/main/kernel/event-bus';
import { AgentPluginRuntime, agentChatRunEventType } from '../../../src/main/plugins/agent/runtime';
import { AgentSessionRepository } from '../../../src/main/plugins/agent/session-repository';
import { AgentRunEventLog } from '../../../src/main/plugins/agent/run-event-log';
import { createAgentDeepAgentExecutor } from '../../../src/main/plugins/agent/deep-agent-executor';
import { createRunCapabilityManifestHash } from '../../../src/main/plugins/agent/run-capability-manifest';
import { RunUsageLedger } from '../../../src/main/services/deep-agent/run-usage-ledger';
import { AgentToolEffectStore } from '../../../src/main/services/deep-agent/tool-effect-store';
import { RocSqliteCheckpointer } from '../../../src/main/services/deep-agent/sqlite-checkpointer';
import { ContextArtifactStore } from '../../../src/main/services/deep-agent/context/context-artifact-store';
import { RocSqliteStore } from '../../../src/main/services/memory/sqlite-store';
import { RocPaths } from '../../../src/main/services/paths';
import type { LangChainChatModelHandle } from '../../../src/main/services/langchain-model-factory';
import { agentTaskViewSchema, qualityHash } from './agent-task-view';

// stdout is exclusively the host protocol; application/library logging belongs to stderr.
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...values: unknown[]) => process.stderr.write(`${values.map(String).join(' ')}\n`);
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
type WorkerInput = {
  view: unknown; providerId: string; modelId: string; temperature: number;
  isolationProbePaths: string[]; isolationProbePort: number | null;
};
const input = await receive() as WorkerInput;
const view = agentTaskViewSchema.parse(input.view);
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
const manifest = { ...manifestBase, manifestHash: createRunCapabilityManifestHash(manifestBase) };
let requestCount = 0;
const model = new ChatOpenAI({
  model: input.modelId, apiKey: ['fixture', 'stdio'].join('-'), temperature: input.temperature,
  streaming: false, maxRetries: 0, maxTokens: 4096,
  configuration: {
    baseURL: 'http://roc-evaluation.invalid/v1',
    fetch: async (_url, init) => {
      const original = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const { stream_options: _streamOptions, ...parameters } = original;
      const body = { ...parameters, stream: false };
      send({ type: 'request', index: requestCount, body, requestHash: qualityHash(body) });
      const reply = await receive() as { type: string; body?: unknown };
      if (reply.type !== 'response') throw new Error('quality_worker_provider_failed');
      if (original.stream !== true) {
        return new Response(JSON.stringify(reply.body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // The application executor streams locally; the trusted host makes one bounded
      // non-streaming completion and this bridge presents its result as SDK chunks.
      const completion = reply.body as { id: string; created: number; model: string; usage: unknown;
        choices: Array<{ index: number; message: unknown; finish_reason: string }> };
      const chunk = { id: completion.id, object: 'chat.completion.chunk', created: completion.created,
        model: completion.model, choices: completion.choices.map(choice => ({
          index: choice.index, delta: choice.message, finish_reason: choice.finish_reason
        })) };
      const usage = { ...chunk, choices: [], usage: completion.usage };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  }
});
const runEventLog = new AgentRunEventLog(db);
const repository = new AgentSessionRepository(db, { runEventLog });
const handle: LangChainChatModelHandle = {
  model, modelId: input.modelId,
  provider: { id: input.providerId, name: 'Evaluation host', type: 'openai_compatible',
    enabled: true, models: [], endpoint: 'http://roc-evaluation.invalid/v1', credentialRef: null },
  runtime: { providerType: 'openai_compatible', baseUrl: null, streaming: false,
    modelKwargs: {}, contextWindowTokens: 65536, maxOutputTokens: 4096 }
};
const eventBus = new EventBus({ error: (message, metadata) => {
  process.stderr.write(`${JSON.stringify({ message, metadata })}\n`);
} });
let resolveOutput: (output: string) => void;
let rejectOutput: (error: Error) => void;
const terminal = new Promise<string>((resolve, reject) => { resolveOutput = resolve; rejectOutput = reject; });
eventBus.subscribe<{ type: string }>(agentChatRunEventType, event => {
  send({ type: 'event', event: event.payload });
  if (event.payload.type === 'run_interrupted') rejectOutput(new Error('quality_worker_interrupted'));
});
eventBus.subscribe<{ assistantMessage: string }>('agent.run.completed', event => resolveOutput(event.payload.assistantMessage));
eventBus.subscribe<{ error: string }>('agent.run.failed', event => rejectOutput(new Error(event.payload.error)));
const runtime = new AgentPluginRuntime({
  repository, eventBus, runEventLog, executionGrantBroker: openExecutionGrantBroker(db),
  deepAgentExecutor: createAgentDeepAgentExecutor({
    executionGrantBroker: openExecutionGrantBroker(db),
    usageLedger: new RunUsageLedger(db), capabilities: new CapabilityRegistry(),
    checkpointer: new RocSqliteCheckpointer(db), contextArtifactStore: new ContextArtifactStore(db),
    paths, sessionHistory: repository, store: new RocSqliteStore(memoryDb), toolEffectStore: new AgentToolEffectStore(db)
  }),
  modelFactory: {
    createDefaultModelHandle: async () => ({ providerId: input.providerId, modelId: input.modelId, langChainHandle: handle }),
    createModelHandleByProviderAndModel: async () => ({ providerId: input.providerId, modelId: input.modelId, langChainHandle: handle })
  },
  capabilityPreviewProvider: async () => ({
    runnable: false, modelId: input.modelId, builtInTools: [], toolCards: [], skillCards: [],
    subagents: [], interruptOn: {}, manifest, reason: 'No connected capabilities; evaluation host supplies the model.'
  })
});
try {
  const prompt = view.conversationTurns === undefined ? view.prompt
    : `${view.conversationTurns.map((turn, index) => `Prior user turn ${index + 1}:\n${turn}`).join('\n\n')}\n\nCurrent user turn:\n${view.prompt}`;
  const started = await runtime.startRun({ input: prompt, mode: 'chat', enabledCapabilities: { mcpServers: [], skills: [] } });
  const run = repository.getRun(started.runId);
  if (run === null) throw new Error('quality_worker_run_missing');
  const output = await terminal;
  await runtime.shutdown();
  send({ type: 'result', output,
    requests: requestCount, runId: run.id, threadId: run.threadId, manifestHash: manifest.manifestHash });
} finally {
  db.close();
  memoryDb.close();
  lines.close();
}
