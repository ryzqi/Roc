const { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { app, safeStorage } = require('electron');

const repoRoot = resolve(__dirname, '..', '..');
const dataRoot = process.env.ROC_DATA_ROOT || join(homedir(), '.roc');
const diagnosticsDir = join(dataRoot, 'diagnostics');
const logPath = join(diagnosticsDir, 'agnes-tool-call-live.log'); const resultPath = join(diagnosticsDir, 'agnes-tool-call-live.json');
const userDataRoot = process.env.ROC_USER_DATA || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'roc');
app.setName('roc');
app.setPath('userData', userDataRoot);

function record(line) {
  mkdirSync(diagnosticsDir, { recursive: true });
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

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

function createSafeStorageBackend() {
  return {
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    encryptString: (plaintext) => safeStorage.encryptString(plaintext),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable()
  };
}

function pickAgnesProvider(configService) {
  const providersConfig = configService.getProviders();
  const provider = providersConfig.providers.find((entry) => entry.id === 'agnes' && entry.type === 'openai_compatible');
  if (!provider) {
    throw new Error('agnes_provider_missing');
  }
  const model =
    provider.models.find((entry) => entry.id === providersConfig.defaultModelId && entry.enabled) ||
    provider.models.find((entry) => entry.enabled);
  if (!model) {
    throw new Error('agnes_enabled_model_missing');
  }
  return { provider, model };
}

function createWebSearchTool(toolModule, z) {
  const schema = z.object({
    query: z.string()
  });
  return toolModule.tool(async ({ query }) => `result:${query}`, {
    name: 'web_search',
    description: 'Search the web for current information. Use this when the user asks to search.',
    schema
  });
}

function toolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  };
}

function rawRequestBody(provider, modelId) {
  return {
    model: modelId,
    messages: [
      {
        role: 'system',
        content: 'You must call the web_search tool. Do not answer directly.'
      },
      {
        role: 'user',
        content: 'Call web_search with query agnes.'
      }
    ],
    stream: true,
    tools: [toolDefinition()],
    tool_choice: {
      type: 'function',
      function: { name: 'web_search' }
    },
    ...(provider.options?.modelKwargs || {}),
    ...(provider.options?.reasoning === undefined ? {} : { reasoning: provider.options.reasoning })
  };
}

async function collectRawSse(provider, modelId, apiKey, signal) {
  const response = await fetch(`${provider.endpoint.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(rawRequestBody(provider, modelId)),
    signal
  });
  const result = {
    ok: response.ok,
    status: response.status,
    samples: [],
    errorBody: null
  };
  if (!response.ok) {
    result.errorBody = (await response.text()).slice(0, 500);
    return result;
  }
  if (!response.body || !response.body.getReader) {
    result.errorBody = 'missing_response_body';
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (result.samples.length < 30) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const payload = trimmed.slice('data:'.length).trim();
      if (payload.length === 0 || payload === '[DONE]') {
        continue;
      }
      try {
        result.samples.push(summarizeRawSsePayload(JSON.parse(payload)));
      } catch {
        result.samples.push({ parseError: true, length: payload.length });
      }
      if (result.samples.length >= 30) {
        break;
      }
    }
  }
  await reader.cancel().catch(() => {});
  return result;
}

function summarizeRawSsePayload(payload) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const delta = choice && typeof choice === 'object' ? choice.delta : undefined;
  const toolCalls = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  return {
    idPresent: typeof payload.id === 'string',
    finishReason: choice && typeof choice === 'object' ? choice.finish_reason ?? null : null,
    contentLength: typeof delta?.content === 'string' ? delta.content.length : 0,
    reasoningLength: typeof delta?.reasoning_content === 'string' ? delta.reasoning_content.length : 0,
    toolCalls: toolCalls.map((call) => ({
      index: typeof call.index === 'number' ? call.index : null,
      hasId: typeof call.id === 'string' && call.id.length > 0,
      type: typeof call.type === 'string' ? call.type : null,
      name: typeof call.function?.name === 'string' ? call.function.name : null,
      argsLength: typeof call.function?.arguments === 'string' ? call.function.arguments.length : 0
    }))
  };
}

async function collectModelStream(model, webSearchTool, HumanMessage, signal) {
  const boundModel = model.bindTools([webSearchTool], {
    tool_choice: {
      type: 'function',
      function: { name: 'web_search' }
    }
  });
  const stream = await boundModel.stream([new HumanMessage('Call web_search with query agnes.')], { signal });
  let aggregated = null;
  const samples = [];
  let chunkCount = 0;
  for await (const chunk of stream) {
    chunkCount += 1;
    if (samples.length < 20) {
      samples.push(summarizeMessageChunk(chunk));
    }
    aggregated = aggregated === null ? chunk : aggregated.concat(chunk);
  }
  return {
    chunkCount,
    samples,
    aggregated: summarizeAiMessage(aggregated)
  };
}

async function collectLangChainAgentRun(createAgent, model, webSearchTool, signal) {
  const agent = createAgent({
    model,
    tools: [webSearchTool],
    systemPrompt: 'Use web_search when the user asks to search. After receiving the tool result, answer DONE.'
  });
  const run = await agent.streamEvents(
    {
      messages: [
        {
          role: 'user',
          content: 'Use web_search once with query agnes, then answer DONE.'
        }
      ]
    },
    { version: 'v3', recursionLimit: 6, signal }
  );
  const toolCalls = [];
  for await (const call of run.toolCalls) {
    toolCalls.push({
      name: call.name,
      input: await Promise.resolve(call.input),
      output: readToolOutputContent(await call.output)
    });
  }
  const output = await run.output;
  return {
    toolCalls,
    output: summarizeAgentOutput(output)
  };
}

async function collectRocExecutorRun(createAgentDeepAgentExecutor, handle, webSearchTool, paths, signal) {
  const capabilities = createDiagnosticCapabilities(webSearchTool);
  const executor = createAgentDeepAgentExecutor({ capabilities, paths });
  const run = {
    enabledCapabilities: { mcpServers: ['exa-hosted'], skills: [] },
    endedAt: null,
    id: 'agnes-live',
    modelId: handle.modelId,
    runNumber: 1,
    startedAt: new Date().toISOString(),
    status: 'running',
    threadId: 'agnes-live-thread',
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
    events.push(summarizeChatRunEvent(event));
  }
  const hasFormalOutput = events.some((event) => {
    if (event.type !== 'assistant_block') {
      return false;
    }
    if (event.block.kind === 'text') {
      return typeof event.block.text === 'string' && event.block.text.trim().length > 0;
    }
    return event.block.kind === 'tool_call' && event.block.phase === 'end';
  });
  return {
    eventCount: events.length,
    hasFormalOutput,
    wouldTriggerAgentModelResponseEmpty: !hasFormalOutput,
    events
  };
}

function createDiagnosticCapabilities(webSearchTool) {
  return {
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
        return {
          command: payload?.command || '',
          cwd: payload?.cwd || '',
          exitCode: 1,
          stdout: '',
          stderr: 'shell disabled in Agnes live diagnostic',
          usedRtk: false
        };
      }
      throw new Error(`unexpected_capability:${name}`);
    },
    list: () => [],
    register: () => {},
    subscribe: () => () => {}
  };
}

function summarizeMessageChunk(chunk) {
  return {
    contentLength: typeof chunk.content === 'string' ? chunk.content.length : 0,
    reasoningBlocks: countContentBlocks(chunk, 'reasoning'),
    toolCallChunks: Array.isArray(chunk.tool_call_chunks)
      ? chunk.tool_call_chunks.map((call) => ({
          id: typeof call.id === 'string' ? call.id : null,
          name: typeof call.name === 'string' ? call.name : null,
          index: typeof call.index === 'number' ? call.index : null,
          argsLength: typeof call.args === 'string' ? call.args.length : 0
        }))
      : []
  };
}

function summarizeAiMessage(message) {
  if (!message) {
    return null;
  }
  return {
    contentLength: typeof message.content === 'string' ? message.content.length : 0,
    reasoningBlocks: countContentBlocks(message, 'reasoning'),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    invalidToolCalls: Array.isArray(message.invalid_tool_calls) ? message.invalid_tool_calls : []
  };
}

function summarizeAgentOutput(output) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.messages)) {
    return { messageCount: 0, lastMessage: null };
  }
  const lastMessage = output.messages.at(-1);
  return {
    messageCount: output.messages.length,
    lastMessage: summarizeFinalMessage(lastMessage)
  };
}

function summarizeFinalMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  return {
    type: message._getType ? message._getType() : message.type ?? message.role ?? null,
    content: typeof message.content === 'string' ? message.content : null,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined
  };
}

function summarizeChatRunEvent(event) {
  if (!event || typeof event !== 'object') {
    return event;
  }
  if (event.type !== 'assistant_block') {
    return { type: event.type };
  }
  const block = event.block;
  return {
    type: event.type,
    block:
      block.kind === 'tool_call'
        ? {
            kind: block.kind,
            name: block.name,
            phase: block.phase,
            input: block.input,
            output: block.output,
            error: block.error
          }
        : {
            kind: block.kind,
            phase: block.phase,
            textLength: typeof block.text === 'string' ? block.text.length : 0
          }
  };
}

function countContentBlocks(message, type) {
  const blocks = Array.isArray(message.contentBlocks)
    ? message.contentBlocks
    : Array.isArray(message.content)
      ? message.content
      : [];
  return blocks.filter((block) => block && block.type === type).length;
}

function readToolOutputContent(value) {
  if (value && typeof value === 'object' && value.content !== undefined) {
    return value.content;
  }
  if (!value || typeof value !== 'object' || !value.kwargs || typeof value.kwargs !== 'object') {
    return value;
  }
  return value.kwargs.content;
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

async function run() {
  const modules = loadRocModules();
  const { HumanMessage } = require('@langchain/core/messages');
  const toolModule = require('@langchain/core/tools');
  const z = require('zod');
  const { createAgent } = await import('langchain');
  const paths = new modules.RocPaths(dataRoot);
  const configService = new modules.ConfigService(paths);
  const secretService = new modules.SecretService(paths, createSafeStorageBackend());
  const { provider, model } = pickAgnesProvider(configService);
  const secretPath = join(paths.secretsDir, `${provider.id}.bin`);
  const secretStored = existsSync(secretPath);
  const apiKey = secretService.getProviderSecret(provider.id);
  const factory = new modules.LangChainModelFactory(configService, secretService, {
    info: () => {},
    warn: () => {}
  });
  const handle = await factory.createProviderChatModel(provider.id, { streaming: true });
  const webSearchTool = createWebSearchTool(toolModule, z);
  return {
    dataRoot,
    userDataRoot,
    provider: {
      id: provider.id,
      endpoint: provider.endpoint,
      modelId: model.id,
      options: provider.options
    },
    secret: { stored: secretStored, decrypted: apiKey.length > 0 },
    rawSse: await withTimeout('raw_sse', 45000, (signal) => collectRawSse(provider, model.id, apiKey, signal)),
    modelStream: await withTimeout('model_stream', 90000, (signal) =>
      collectModelStream(handle.model, webSearchTool, HumanMessage, signal)
    ),
    langchainAgent: await withTimeout('langchain_agent', 120000, (signal) =>
      collectLangChainAgentRun(createAgent, handle.model, webSearchTool, signal)
    ),
    rocExecutor: await withTimeout('roc_executor', 150000, (signal) =>
      collectRocExecutorRun(modules.createAgentDeepAgentExecutor, handle, webSearchTool, paths, signal)
    )
  };
}

record('STEP script_loaded');

app.whenReady().then(async () => {
  record('STEP app_ready');
  try {
    const result = await run();
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    record(`STEP result_written:${resultPath}`);
  } catch (error) {
    const serialized = serializeError(error);
    writeFileSync(resultPath, `${JSON.stringify({ ok: false, error: serialized }, null, 2)}\n`, 'utf8');
    record(`ERROR ${serialized.name}:${serialized.message}`);
  } finally {
    app.exit(0);
  }
});
