const { mkdirSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const { HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { tool } = require('@langchain/core/tools');
const { ChatOpenAI } = require('@langchain/openai');
const { createAgent } = require('langchain');
const { createDeepAgent } = require('deepagents');
const { z } = require('zod');

const endpoint = process.env.AGNES_ENDPOINT || 'https://apihub.agnes-ai.com/v1';
const modelId = process.env.AGNES_MODEL || 'agnes-2.0-flash';
const apiKey = process.env.AGNES_API_KEY;
const dataRoot = process.env.ROC_DATA_ROOT || join(homedir(), '.roc');
const diagnosticsDir = join(dataRoot, 'diagnostics');
const resultPath = join(diagnosticsDir, 'langchain-agnes-native-tool-call-live.json');
const reasoning = { effort: process.env.AGNES_REASONING_EFFORT || 'xhigh' };
const chatTemplateKwargs = { enable_thinking: true };
const prompt = 'Use web_search exactly once with query agnes, then answer DONE.';

if (typeof apiKey !== 'string' || apiKey.length === 0) {
  throw new Error('AGNES_API_KEY_missing');
}

function createModel() {
  return new ChatOpenAI({
    apiKey,
    configuration: { baseURL: endpoint.replace(/\/+$/, ''), maxRetries: 0 },
    maxRetries: 0,
    model: modelId,
    modelKwargs: { chat_template_kwargs: chatTemplateKwargs },
    reasoning,
    streamUsage: false,
    streaming: true,
    temperature: 0,
    timeout: 120_000
  });
}

function createWebSearchTool() {
  const schema = z.object({ query: z.string() });
  return tool(async ({ query }) => `result:${query}`, {
    name: 'web_search',
    description: 'Search the web for current information.',
    schema
  });
}

function rawToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      }
    }
  };
}

function rawRequestBody() {
  return {
    model: modelId,
    messages: [
      { role: 'system', content: 'You must call the web_search tool. Do not answer directly.' },
      { role: 'user', content: 'Call web_search with query agnes.' }
    ],
    stream: true,
    tools: [rawToolDefinition()],
    tool_choice: { type: 'function', function: { name: 'web_search' } },
    reasoning,
    chat_template_kwargs: chatTemplateKwargs
  };
}

async function collectRawStreamingSse(signal) {
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(rawRequestBody()),
    signal
  });
  const summary = {
    ok: response.ok,
    status: response.status,
    chunkCount: 0,
    reasoningLength: 0,
    contentLength: 0,
    contentPreview: '',
    toolCallChunkCount: 0,
    toolCallChunks: [],
    finishReasons: [],
    doneSeen: false,
    errorBody: null
  };
  if (!response.ok) {
    summary.errorBody = (await response.text()).slice(0, 800);
    return summary;
  }
  if (!response.body?.getReader) {
    summary.errorBody = 'missing_response_body';
    return summary;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (summary.chunkCount < 1_000) {
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
      summarizeRawPayload(summary, payload);
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

function summarizeRawPayload(summary, payload) {
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
    summary.contentPreview = `${summary.contentPreview}${delta.content}`.slice(0, 200);
  }
  const chunks = summarizeRawToolCalls(delta?.tool_calls);
  summary.toolCallChunkCount += chunks.length;
  summary.toolCallChunks.push(...chunks.slice(0, Math.max(0, 40 - summary.toolCallChunks.length)));
}

function bindForcedTool(model, webSearchTool) {
  return model.bindTools([webSearchTool], {
    tool_choice: { type: 'function', function: { name: 'web_search' } }
  });
}

async function collectModelInvoke(model, webSearchTool, signal) {
  const message = await bindForcedTool(model, webSearchTool).invoke(
    [new HumanMessage('Call web_search with query agnes.')],
    { signal }
  );
  return summarizeAiMessage(message);
}

async function collectModelStream(model, webSearchTool, signal) {
  const stream = await bindForcedTool(model, webSearchTool).stream(
    [new HumanMessage('Call web_search with query agnes.')],
    { signal }
  );
  let aggregated = null;
  const chunks = [];
  let chunkCount = 0;
  let reasoningLength = 0;
  for await (const chunk of stream) {
    chunkCount += 1;
    reasoningLength += readReasoningLength(chunk);
    if (chunks.length < 60) {
      chunks.push(summarizeAiChunk(chunk));
    }
    aggregated = aggregated === null ? chunk : aggregated.concat(chunk);
  }
  return { chunkCount, reasoningLength, chunks, aggregated: summarizeAiMessage(aggregated) };
}

async function collectLangChainAgent(model, webSearchTool, signal) {
  const agent = createAgent({
    model,
    tools: [webSearchTool],
    systemPrompt: 'You must call web_search when the user asks to search. After the tool result, answer DONE.'
  });
  const run = await agent.streamEvents({ messages: [{ role: 'user', content: prompt }] }, { version: 'v3', recursionLimit: 8, signal });
  return await collectRunStream(run);
}

async function collectDeepAgent(model, webSearchTool, signal) {
  const agent = createDeepAgent({
    model,
    tools: [webSearchTool],
    systemPrompt: 'You must call web_search when the user asks to search. After the tool result, answer DONE.'
  });
  const run = await agent.streamEvents({ messages: [{ role: 'user', content: prompt }] }, { version: 'v3', recursionLimit: 8, signal });
  return await collectRunStream(run);
}

async function collectRunStream(run) {
  const [messages, toolCalls, output] = await Promise.all([
    collectRunMessages(run.messages),
    collectRunToolCalls(run.toolCalls),
    run.output
  ]);
  return { messages, toolCalls, output: summarizeAgentOutput(output) };
}

async function collectRunMessages(source) {
  const messages = [];
  for await (const message of source) {
    messages.push(await summarizeRunMessage(message));
  }
  return messages;
}

async function collectRunToolCalls(source) {
  const calls = [];
  for await (const call of source) {
    calls.push({
      name: call.name,
      input: await Promise.resolve(call.input),
      output: readToolOutputContent(await call.output),
      status: await Promise.resolve(call.status).catch(() => null)
    });
  }
  return calls;
}

async function summarizeRunMessage(message) {
  const [text, reasoningText, output] = await Promise.all([
    collectText(message.text),
    collectText(message.reasoning),
    Promise.resolve(message.output).catch(() => null)
  ]);
  return {
    textLength: text.length,
    reasoningLength: reasoningText.length,
    output: summarizeAiMessage(output)
  };
}

async function collectText(value) {
  if (value === null || value === undefined || typeof value[Symbol.asyncIterator] !== 'function') {
    return '';
  }
  const chunks = [];
  for await (const delta of value) {
    if (typeof delta === 'string') {
      chunks.push(delta);
    }
  }
  return chunks.join('');
}

function summarizeAiChunk(chunk) {
  return {
    contentLength: readContentLength(chunk.content),
    reasoningLength: readReasoningLength(chunk),
    toolCallChunks: summarizeLangChainToolCallChunks(chunk.tool_call_chunks),
    toolCalls: summarizeLangChainToolCalls(chunk.tool_calls),
    invalidToolCalls: summarizeInvalidToolCalls(chunk.invalid_tool_calls)
  };
}

function summarizeAiMessage(message) {
  if (message === null || message === undefined) {
    return null;
  }
  return {
    type: typeof message._getType === 'function' ? message._getType() : message.type ?? null,
    contentLength: readContentLength(message.content),
    contentPreview: typeof message.content === 'string' ? message.content.slice(0, 200) : null,
    reasoningLength: readReasoningLength(message),
    contentBlockTypes: Array.isArray(message.contentBlocks) ? message.contentBlocks.map((block) => block?.type ?? null) : [],
    toolCallChunks: summarizeLangChainToolCallChunks(message.tool_call_chunks),
    toolCalls: summarizeLangChainToolCalls(message.tool_calls),
    invalidToolCalls: summarizeInvalidToolCalls(message.invalid_tool_calls)
  };
}

function summarizeAgentOutput(output) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.messages)) {
    return { messageCount: 0, lastMessage: null };
  }
  return {
    messageCount: output.messages.length,
    lastMessage: summarizeAiMessage(output.messages.at(-1)),
    toolMessages: output.messages.filter((message) => ToolMessage.isInstance(message)).map(summarizeToolMessage)
  };
}

function summarizeToolMessage(message) {
  return {
    name: message.name ?? null,
    toolCallId: message.tool_call_id ?? null,
    content: typeof message.content === 'string' ? message.content.slice(0, 200) : null
  };
}

function summarizeRawToolCalls(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((call) => ({
    index: typeof call?.index === 'number' ? call.index : null,
    id: typeof call?.id === 'string' ? call.id : null,
    type: typeof call?.type === 'string' ? call.type : null,
    name: typeof call?.function?.name === 'string' ? call.function.name : null,
    argsLength: typeof call?.function?.arguments === 'string' ? call.function.arguments.length : 0,
    argsPreview: typeof call?.function?.arguments === 'string' ? call.function.arguments.slice(0, 120) : null
  }));
}

function summarizeLangChainToolCallChunks(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((call) => ({
    index: typeof call?.index === 'number' ? call.index : null,
    id: typeof call?.id === 'string' ? call.id : null,
    name: typeof call?.name === 'string' ? call.name : null,
    argsLength: typeof call?.args === 'string' ? call.args.length : 0,
    argsPreview: typeof call?.args === 'string' ? call.args.slice(0, 120) : null,
    type: call?.type ?? null
  }));
}

function summarizeLangChainToolCalls(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((call) => ({
    type: call?.type ?? null,
    id: typeof call?.id === 'string' ? call.id : null,
    name: typeof call?.name === 'string' ? call.name : null,
    args: call?.args ?? null
  }));
}

function summarizeInvalidToolCalls(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((call) => ({
    type: call?.type ?? null,
    id: typeof call?.id === 'string' ? call.id : null,
    name: typeof call?.name === 'string' ? call.name : null,
    args: typeof call?.args === 'string' ? call.args.slice(0, 200) : call?.args ?? null,
    error: typeof call?.error === 'string' ? call.error : null
  }));
}

function readContentLength(content) {
  if (typeof content === 'string') {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.reduce((total, block) => total + (typeof block?.text === 'string' ? block.text.length : 0), 0);
}

function readReasoningLength(message) {
  return (
    readReasoningText(message?.additional_kwargs).length +
    readReasoningText(message?.response_metadata).length +
    readReasoningBlocksLength(message)
  );
}

function readReasoningText(value) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return '';
  }
  if (typeof value.reasoning_content === 'string') {
    return value.reasoning_content;
  }
  return typeof value.reasoningContent === 'string' ? value.reasoningContent : '';
}

function readReasoningBlocksLength(message) {
  const blocks = Array.isArray(message?.contentBlocks)
    ? message.contentBlocks
    : Array.isArray(message?.content)
      ? message.content
      : [];
  return blocks.reduce((total, block) => {
    if (block?.type !== 'reasoning') {
      return total;
    }
    return total + (typeof block.reasoning === 'string' ? block.reasoning.length : 0) + (typeof block.text === 'string' ? block.text.length : 0);
  }, 0);
}

function readToolOutputContent(value) {
  if (ToolMessage.isInstance(value)) {
    return value.content;
  }
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
  const webSearchTool = createWebSearchTool();
  const model = createModel();
  return {
    provider: { endpoint, modelId, requestOptions: { reasoning, chat_template_kwargs: chatTemplateKwargs } },
    rawStreamingSse: await withTimeout('raw_streaming_sse', 120_000, collectRawStreamingSse),
    modelInvoke: await withTimeout('model_invoke', 120_000, (signal) => collectModelInvoke(model, webSearchTool, signal)),
    modelStream: await withTimeout('model_stream', 120_000, (signal) => collectModelStream(model, webSearchTool, signal)),
    langChainAgent: await withTimeout('langchain_agent', 180_000, (signal) => collectLangChainAgent(model, webSearchTool, signal)),
    deepAgent: await withTimeout('deep_agent', 180_000, (signal) => collectDeepAgent(model, webSearchTool, signal))
  };
}

run()
  .then((result) => {
    mkdirSync(diagnosticsDir, { recursive: true });
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ resultPath, provider: result.provider }, null, 2));
  })
  .catch((error) => {
    mkdirSync(diagnosticsDir, { recursive: true });
    const result = { ok: false, error: serializeError(error) };
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  });
