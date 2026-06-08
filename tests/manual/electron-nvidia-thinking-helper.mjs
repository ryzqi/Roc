import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app, safeStorage } from 'electron';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';

function resolveDataRoot() {
  return process.env.ROC_DATA_ROOT ?? join(homedir(), '.roc');
}

const dataRoot = resolveDataRoot();
const diagnosticsDir = join(dataRoot, 'diagnostics');
const logPath = join(diagnosticsDir, 'electron-nvidia-thinking-helper.log');
const resultPath = join(diagnosticsDir, 'electron-nvidia-thinking-helper.json');

function record(line) {
  mkdirSync(diagnosticsDir, { recursive: true });
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function decryptSecret(path) {
  const encrypted = readFileSync(path);
  return safeStorage.decryptString(encrypted);
}

function pickNvidiaConfig(document) {
  const providers = document?.providers?.providers;
  if (!Array.isArray(providers)) {
    throw new Error('settings providers missing');
  }
  const provider = providers.find((entry) => entry?.id === 'nvidia' && entry?.type === 'nvidia');
  if (!provider) {
    throw new Error('nvidia provider missing');
  }
  const model =
    provider.models.find((entry) => entry?.id === document?.providers?.defaultModelId && entry?.enabled) ??
    provider.models.find((entry) => entry?.enabled);
  if (!model) {
    throw new Error('no enabled nvidia model');
  }
  return { provider, model };
}

function buildModelKwargs(provider, streaming) {
  const kwargs = {};
  if (typeof provider?.options?.thinking === 'boolean') {
    kwargs.chat_template_kwargs = {
      thinking: provider.options.thinking
    };
  }
  if (typeof provider?.options?.includeReasoning === 'boolean' && !streaming) {
    kwargs.include_reasoning = provider.options.includeReasoning;
  }
  return kwargs;
}

async function collectRawSseSample({ apiKey, endpoint, modelId, thinking }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('raw_sse_timeout')), 15000);
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: 'user',
            content: '请先思考 2+2，再只输出数字。'
          }
        ],
        stream: true,
        chat_template_kwargs: {
          thinking
        }
      }),
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        status: response.status,
        ok: response.ok,
        samples: [],
        error: 'missing_response_body'
      };
    }
    const decoder = new TextDecoder();
    let buffer = '';
    const samples = [];
    while (samples.length < 12) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice('data:'.length).trim();
        if (payload.length === 0 || payload === '[DONE]') {
          continue;
        }
        try {
          samples.push(JSON.parse(payload));
        } catch {
          samples.push({ raw: payload });
        }
        if (samples.length >= 12) {
          break;
        }
      }
    }
    reader.cancel().catch(() => {});
    return {
      status: response.status,
      ok: response.ok,
      samples,
      error: null
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      samples: [],
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  const settingsPath = join(dataRoot, 'config', 'settings.json');
  const secretPath = join(dataRoot, 'secrets', 'nvidia.bin');
  const settings = readJson(settingsPath);
  record('STEP settings_loaded');
  const { provider, model } = pickNvidiaConfig(settings);
  record(`STEP provider_selected:${model.id}`);
  const apiKey = decryptSecret(secretPath);
  record('STEP secret_decrypted');
  const prompt = '请先思考 2+2，再只输出数字。';

  const streamingModel = new ChatOpenAI({
    model: model.id,
    apiKey,
    timeout: 30000,
    configuration: {
      baseURL: provider.endpoint
    },
    streaming: true,
    modelKwargs: buildModelKwargs(provider, true)
  });

  const invokeModel = new ChatOpenAI({
    model: model.id,
    apiKey,
    timeout: 30000,
    configuration: {
      baseURL: provider.endpoint
    },
    streaming: false,
    modelKwargs: buildModelKwargs(provider, false)
  });

  const streamSamples = [];
  let chunkCount = 0;
  let reasoningChunkCount = 0;
  let textChunkCount = 0;
  const stream = await streamingModel.stream([new HumanMessage(prompt)]);
  record('STEP stream_opened');
  for await (const chunk of stream) {
    chunkCount += 1;
    if (streamSamples.length < 12) {
      streamSamples.push({
        index: chunkCount,
        content: chunk.content,
        contentBlocks: chunk.contentBlocks,
        additional_kwargs: chunk.additional_kwargs,
        response_metadata: chunk.response_metadata
      });
    }
    const additionalReasoning = chunk.additional_kwargs?.reasoning_content;
    const blockReasoning = Array.isArray(chunk.contentBlocks)
      ? chunk.contentBlocks.filter((entry) => entry?.type === 'reasoning')
      : [];
    if (typeof additionalReasoning === 'string' && additionalReasoning.length > 0) {
      reasoningChunkCount += 1;
    }
    if (blockReasoning.length > 0) {
      reasoningChunkCount += blockReasoning.length;
    }
    if (typeof chunk.content === 'string' && chunk.content.length > 0) {
      textChunkCount += 1;
    }
    if (chunkCount >= 12 || (reasoningChunkCount > 0 && textChunkCount > 0)) {
      break;
    }
  }
  record(`STEP stream_sampled:${chunkCount}`);

  const invokeResponse = await invokeModel.invoke([new HumanMessage(prompt)]);
  record('STEP invoke_completed');
  const rawSse = await collectRawSseSample({
    apiKey,
    endpoint: provider.endpoint,
    modelId: model.id,
    thinking: provider.options?.thinking ?? true
  });

  return {
    dataRoot,
    provider: {
      id: provider.id,
      endpoint: provider.endpoint,
      modelId: model.id,
      thinking: provider.options?.thinking ?? null,
      includeReasoning: provider.options?.includeReasoning ?? null
    },
    stream: {
      chunkCount,
      reasoningChunkCount,
      textChunkCount,
      samples: streamSamples
    },
    rawSse,
    invoke: {
      content: invokeResponse.content,
      contentBlocks: invokeResponse.contentBlocks,
      additional_kwargs: invokeResponse.additional_kwargs,
      response_metadata: invokeResponse.response_metadata
    }
  };
}

await app.whenReady();
record('STEP app_ready');

try {
  const result = await run();
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
} finally {
  app.exit(0);
}
