const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { app, safeStorage } = require('electron');

const dataRoot = process.env.ROC_DATA_ROOT || join(homedir(), '.roc');
const userDataRoot = process.env.ROC_USER_DATA || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'roc');
const diagnosticsDir = join(dataRoot, 'diagnostics');
const logPath = join(diagnosticsDir, 'agnes-tool-call-variants.log');
const resultPath = join(diagnosticsDir, 'agnes-tool-call-variants.json');

app.setName('roc');
app.setPath('userData', userDataRoot);

function record(line) {
  mkdirSync(diagnosticsDir, { recursive: true });
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pickAgnes(settings) {
  const providers = settings?.providers?.providers;
  if (!Array.isArray(providers)) {
    throw new Error('providers_missing');
  }
  const provider = providers.find((entry) => entry?.id === 'agnes' && entry?.type === 'openai_compatible');
  if (!provider) {
    throw new Error('agnes_provider_missing');
  }
  const model =
    provider.models.find((entry) => entry?.id === settings.providers.defaultModelId && entry.enabled) ||
    provider.models.find((entry) => entry?.enabled);
  if (!model) {
    throw new Error('agnes_model_missing');
  }
  return { provider, model };
}

function decryptSecret(providerId) {
  const secretPath = join(dataRoot, 'secrets', `${providerId}.bin`);
  if (!existsSync(secretPath)) {
    throw new Error(`secret_missing:${providerId}`);
  }
  return safeStorage.decryptString(readFileSync(secretPath));
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

function baseBody(modelId) {
  return {
    model: modelId,
    messages: [
      { role: 'system', content: 'You must call the web_search tool. Do not answer directly.' },
      { role: 'user', content: 'Call web_search with query agnes.' }
    ],
    stream: true,
    tools: [toolDefinition()],
    tool_choice: { type: 'function', function: { name: 'web_search' } }
  };
}

function variants(provider, modelId) {
  const modelKwargs = provider.options?.modelKwargs || {};
  const reasoning = provider.options?.reasoning;
  return [
    {
      name: 'current_reasoning_plus_enable_thinking',
      body: { ...baseBody(modelId), ...modelKwargs, ...(reasoning === undefined ? {} : { reasoning }) }
    },
    {
      name: 'enable_thinking_only',
      body: { ...baseBody(modelId), ...modelKwargs }
    },
    {
      name: 'reasoning_only',
      body: { ...baseBody(modelId), ...(reasoning === undefined ? {} : { reasoning }) }
    },
    {
      name: 'plain_tools',
      body: baseBody(modelId)
    },
    {
      name: 'enable_thinking_false',
      body: { ...baseBody(modelId), chat_template_kwargs: { enable_thinking: false } }
    }
  ];
}

async function runVariant(provider, apiKey, variant, signal) {
  const response = await fetch(`${provider.endpoint.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(variant.body),
    signal
  });
  const summary = {
    name: variant.name,
    ok: response.ok,
    status: response.status,
    chunkCount: 0,
    reasoningLength: 0,
    contentLength: 0,
    contentPreview: '',
    toolCallChunkCount: 0,
    toolCallSummaries: [],
    finishReasons: [],
    doneSeen: false,
    errorBody: null
  };
  if (!response.ok) {
    summary.errorBody = (await response.text()).slice(0, 500);
    return summary;
  }
  if (!response.body?.getReader) {
    summary.errorBody = 'missing_response_body';
    return summary;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (summary.chunkCount < 800) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const payload = readSsePayload(line);
      if (payload === null) {
        continue;
      }
      if (payload === '[DONE]') {
        summary.doneSeen = true;
        await reader.cancel().catch(() => {});
        return summary;
      }
      applyPayloadSummary(summary, payload);
    }
  }
  await reader.cancel().catch(() => {});
  return summary;
}

function readSsePayload(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const raw = trimmed.slice('data:'.length).trim();
  if (raw.length === 0) {
    return null;
  }
  if (raw === '[DONE]') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { parseError: true, rawLength: raw.length };
  }
}

function applyPayloadSummary(summary, payload) {
  summary.chunkCount += 1;
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const delta = choice?.delta;
  if (typeof choice?.finish_reason === 'string') {
    summary.finishReasons.push(choice.finish_reason);
  }
  if (typeof delta?.reasoning_content === 'string') {
    summary.reasoningLength += delta.reasoning_content.length;
  }
  if (typeof delta?.content === 'string') {
    summary.contentLength += delta.content.length;
    if (summary.contentPreview.length < 200) {
      summary.contentPreview = `${summary.contentPreview}${delta.content}`.slice(0, 200);
    }
  }
  const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
  summary.toolCallChunkCount += toolCalls.length;
  for (const call of toolCalls) {
    if (summary.toolCallSummaries.length >= 20) {
      continue;
    }
    summary.toolCallSummaries.push({
      index: typeof call.index === 'number' ? call.index : null,
      hasId: typeof call.id === 'string' && call.id.length > 0,
      type: typeof call.type === 'string' ? call.type : null,
      name: typeof call.function?.name === 'string' ? call.function.name : null,
      argsLength: typeof call.function?.arguments === 'string' ? call.function.arguments.length : 0
    });
  }
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
  const settings = readJson(join(dataRoot, 'config', 'settings.json'));
  const { provider, model } = pickAgnes(settings);
  const apiKey = decryptSecret(provider.id);
  const results = [];
  for (const variant of variants(provider, model.id)) {
    record(`STEP variant_start:${variant.name}`);
    results.push(await withTimeout(variant.name, 90000, (signal) => runVariant(provider, apiKey, variant, signal)));
  }
  return {
    dataRoot,
    userDataRoot,
    provider: {
      id: provider.id,
      endpoint: provider.endpoint,
      modelId: model.id,
      options: provider.options
    },
    secret: { decrypted: apiKey.length > 0 },
    results
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
