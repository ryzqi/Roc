const { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { app, safeStorage } = require('electron');

const repoRoot = resolve(__dirname, '..', '..');
const dataRoot = process.env.ROC_DATA_ROOT || join(homedir(), '.roc');
const userDataRoot = process.env.ROC_USER_DATA || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'roc');
const diagnosticsDir = join(dataRoot, 'diagnostics');
const resultPath = join(diagnosticsDir, 'agnes-agent-override.json');

app.setName('roc');
app.setPath('userData', userDataRoot);

function registerTsx() {
  const registerPath = join(repoRoot, 'node_modules', '.pnpm', 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs');
  if (!existsSync(registerPath)) {
    throw new Error(`tsx_register_missing:${registerPath}`);
  }
  require(realpathSync(registerPath));
}

function loadRocModules() {
  registerTsx();
  return {
    ConfigService: require(join(repoRoot, 'src/main/services/config-service.ts')).ConfigService,
    LangChainModelFactory: require(join(repoRoot, 'src/main/services/langchain-model-factory.ts')).LangChainModelFactory,
    RocPaths: require(join(repoRoot, 'src/main/services/paths.ts')).RocPaths,
    SecretService: require(join(repoRoot, 'src/main/services/secret-service.ts')).SecretService,
    createAgentDeepAgentExecutor: require(join(repoRoot, 'src/main/plugins/agent/deep-agent-executor.ts')).createAgentDeepAgentExecutor
  };
}

function safeStorageBackend() {
  return {
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    encryptString: (plaintext) => safeStorage.encryptString(plaintext),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable()
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pickAgnes(configService) {
  const providersConfig = configService.getProviders();
  const provider = providersConfig.providers.find((entry) => entry.id === 'agnes' && entry.type === 'openai_compatible');
  if (!provider) {
    throw new Error('agnes_provider_missing');
  }
  const model =
    provider.models.find((entry) => entry.id === providersConfig.defaultModelId && entry.enabled) ||
    provider.models.find((entry) => entry.enabled);
  if (!model) {
    throw new Error('agnes_model_missing');
  }
  return { provider, model };
}

function toolFriendlyProvider(provider) {
  const options = provider.options || {};
  const { reasoning: _reasoning, ...restOptions } = options;
  const modelKwargs = { ...(restOptions.modelKwargs || {}) };
  modelKwargs.chat_template_kwargs = {
    ...(modelKwargs.chat_template_kwargs || {}),
    enable_thinking: false
  };
  return {
    ...provider,
    options: {
      ...restOptions,
      modelKwargs
    }
  };
}

function templateThinkingOffProvider(provider) {
  const options = provider.options || {};
  const modelKwargs = { ...(options.modelKwargs || {}) };
  modelKwargs.chat_template_kwargs = {
    ...(modelKwargs.chat_template_kwargs || {}),
    enable_thinking: false
  };
  return {
    ...provider,
    options: {
      ...options,
      modelKwargs
    }
  };
}

function createWebSearchTool(toolModule, z) {
  return toolModule.tool(async ({ query }) => `result:${query}`, {
    name: 'web_search',
    description: 'Search the web for current information. Use this when the user asks to search.',
    schema: z.object({
      query: z.string()
    })
  });
}

async function collectAgent(createAgent, model, webSearchTool, signal) {
  const agent = createAgent({
    model,
    tools: [webSearchTool],
    systemPrompt: 'You must use web_search for this request. After receiving the tool result, answer DONE.'
  });
  const run = await agent.streamEvents(
    {
      messages: [{ role: 'user', content: 'Use web_search once with query agnes, then answer DONE.' }]
    },
    { version: 'v3', recursionLimit: 6, signal }
  );
  const toolCalls = [];
  for await (const call of run.toolCalls) {
    toolCalls.push({
      name: call.name,
      input: await Promise.resolve(call.input),
      output: await Promise.resolve(call.output)
    });
  }
  return {
    toolCalls,
    output: summarizeAgentOutput(await run.output)
  };
}

async function collectExecutor(createAgentDeepAgentExecutor, handle, webSearchTool, paths, signal) {
  const executor = createAgentDeepAgentExecutor({
    capabilities: diagnosticCapabilities(webSearchTool),
    paths
  });
  const run = {
    enabledCapabilities: { mcpServers: ['exa-hosted'], skills: [] },
    endedAt: null,
    id: `agnes-override-${Date.now()}`,
    modelId: handle.modelId,
    runNumber: 1,
    startedAt: new Date().toISOString(),
    status: 'running',
    threadId: `agnes-override-thread-${Date.now()}`,
    userInput: 'Use web_search once with query agnes, then answer DONE.'
  };
  const events = [];
  const iterable = await executor.execute({
    abortSignal: signal,
    modelHandle: {
      providerId: handle.provider.id,
      modelId: handle.modelId,
      langChainHandle: handle
    },
    request: {
      enabledCapabilities: run.enabledCapabilities,
      input: run.userInput,
      mode: 'task'
    },
    run
  });
  for await (const event of iterable) {
    if (event.type === 'assistant_block') {
      events.push(summarizeBlock(event.block));
    }
  }
  return {
    eventCount: events.length,
    hasToolEnd: events.some((block) => block.kind === 'tool_call' && block.phase === 'end'),
    hasText: events.some((block) => block.kind === 'text' && block.text.trim().length > 0),
    events: events.slice(0, 30)
  };
}

function diagnosticCapabilities(webSearchTool) {
  return {
    list: () => [],
    invoke: async (name, payload) => {
      if (name === 'workspace.getCurrent') {
        return null;
      }
      if (name === 'mcp.tools.get') {
        return [webSearchTool];
      }
      if (name === 'web.read') {
        return 'diagnostic web_read result';
      }
      if (name === 'shell.execute') {
        return { command: payload?.command || '', cwd: payload?.cwd || '', exitCode: 1, stdout: '', stderr: 'shell disabled', usedRtk: false };
      }
      throw new Error(`unexpected_capability:${name}`);
    }
  };
}

function summarizeBlock(block) {
  if (block.kind === 'tool_call') {
    return { kind: block.kind, phase: block.phase, name: block.name };
  }
  if (block.kind === 'text') {
    return { kind: block.kind, phase: block.phase, text: block.text };
  }
  if (block.kind === 'reasoning') {
    return { kind: block.kind, phase: block.phase, textLength: block.text.length };
  }
  return { kind: block.kind };
}

function summarizeAgentOutput(output) {
  const messages = Array.isArray(output?.messages) ? output.messages : [];
  const last = messages[messages.length - 1];
  return {
    messageCount: messages.length,
    lastType: typeof last?.getType === 'function' ? last.getType() : last?.type ?? null,
    lastContent: typeof last?.content === 'string' ? last.content : null,
    lastToolCalls: Array.isArray(last?.tool_calls) ? last.tool_calls : []
  };
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error)
  };
}

async function withTimeout(label, timeoutMs, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label}_timeout`)), timeoutMs);
  try {
    return { ok: true, value: await fn(controller.signal) };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function runMode(input, mode, provider) {
  const handle = await input.factory.createModelForProvider(provider, input.model.id, { streaming: true });
  return {
    mode,
    options: provider.options,
    agent: await withTimeout(`${mode}_agent`, 120000, (signal) => collectAgent(input.createAgent, handle.model, input.webSearchTool, signal)),
    executor: await withTimeout(`${mode}_executor`, 150000, (signal) =>
      collectExecutor(input.modules.createAgentDeepAgentExecutor, handle, input.webSearchTool, input.paths, signal)
    )
  };
}

async function run() {
  const modules = loadRocModules();
  const { createAgent } = await import('langchain');
  const toolModule = require('@langchain/core/tools');
  const z = require('zod');
  const paths = new modules.RocPaths(dataRoot);
  const configService = new modules.ConfigService(paths);
  const secretService = new modules.SecretService(paths, safeStorageBackend());
  const { provider, model } = pickAgnes(configService);
  secretService.getProviderSecret(provider.id);
  const factory = new modules.LangChainModelFactory(configService, secretService, { info: () => {}, warn: () => {} });
  const input = { modules, createAgent, factory, model, paths, webSearchTool: createWebSearchTool(toolModule, z) };
  return {
    dataRoot,
    userDataRoot,
    provider: { id: provider.id, endpoint: provider.endpoint, modelId: model.id, options: provider.options },
    secret: { decrypted: true },
    settingsSnapshot: readJson(join(dataRoot, 'config', 'settings.json')).providers.defaultProviderId,
    results: [
      await runMode(input, 'current', provider),
      await runMode(input, 'template_thinking_off_keep_reasoning', templateThinkingOffProvider(provider)),
      await runMode(input, 'tool_friendly_disable_thinking', toolFriendlyProvider(provider))
    ]
  };
}

app.whenReady().then(async () => {
  mkdirSync(diagnosticsDir, { recursive: true });
  try {
    writeFileSync(resultPath, `${JSON.stringify(await run(), null, 2)}\n`, 'utf8');
  } catch (error) {
    writeFileSync(resultPath, `${JSON.stringify({ ok: false, error: serializeError(error) }, null, 2)}\n`, 'utf8');
  } finally {
    app.exit(0);
  }
});
