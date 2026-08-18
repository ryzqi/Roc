import type { TokenUsage } from '../../../shared/types';
import * as recordUtils from './record-utils';
import { redact } from './redact';
import { redactUnknown } from './stream-tool-utils';
import type { ToolOutputProjector } from './tool-output-projection';

export type DeepAgentSubagentScope = {
  name: string;
  ordinalPath: readonly number[];
  path: readonly string[];
};

type ScopedDomainEvent = {
  scope: DeepAgentSubagentScope | null;
};

export type DeepAgentDomainEvent =
  | (ScopedDomainEvent & {
      type: 'assistant_delta';
      kind: 'text' | 'reasoning';
      text: string;
    })
  | {
      type: 'usage';
      usageKey: string;
      usage: TokenUsage;
    }
  | (ScopedDomainEvent & {
      type: 'tool_call_started';
      callId: string;
      name: string;
      input: unknown;
    })
  | (ScopedDomainEvent & {
      type: 'tool_call_completed';
      callId: string;
      name: string;
      input: unknown;
      output: unknown;
    })
  | (ScopedDomainEvent & {
      type: 'tool_call_failed';
      callId: string;
      name: string;
      input: unknown;
      error: unknown;
    })
  | {
      type: 'subagent_started';
      scope: DeepAgentSubagentScope;
    }
  | {
      type: 'subagent_completed';
      scope: DeepAgentSubagentScope;
    }
  | {
      type: 'subagent_failed';
      scope: DeepAgentSubagentScope;
      error: string;
    }
  | {
      type: 'run_interrupted';
      interrupts: readonly DeepAgentInterrupt[];
    };

export type DeepAgentInterrupt = {
  interruptId: string;
  payload: unknown;
};

export type DeepAgentDomainRun = {
  events: AsyncIterable<DeepAgentDomainEvent>;
  output: Promise<string | null>;
};

type DeepAgents110V3Message = {
  usageKey: string;
  text: AsyncIterable<string>;
  reasoning: AsyncIterable<string>;
  trailingReasoning: Promise<string | null>;
  usage: AsyncIterable<TokenUsage>;
};

type DeepAgents110V3ToolCallStatus = 'running' | 'finished' | 'error';

type DeepAgents110V3ToolCallOutcome =
  | {
      status: 'finished';
      output: unknown;
    }
  | {
      status: 'error';
      error: string;
    };

type DeepAgents110V3ToolCall = {
  name: string;
  callId: string;
  input: unknown;
  outcome: Promise<DeepAgents110V3ToolCallOutcome>;
};

type DeepAgents110V3SubagentCause = {
  type: 'toolCall';
  toolCallId: string;
};

type DeepAgents110V3Subagent = {
  name: string;
  output: Promise<string | null>;
  messages: AsyncIterable<DeepAgents110V3Message>;
  toolCalls: AsyncIterable<DeepAgents110V3ToolCall>;
  subagents: AsyncIterable<DeepAgents110V3Subagent>;
};

class DeepAgents110V3ContractError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'DeepAgents110V3ContractError';
  }
}

export function adaptDeepAgentRun(
  run: unknown,
  options: { projectToolOutput: ToolOutputProjector }
): DeepAgentDomainRun {
  const rawRun = requireRecord(run, 'deep_agents_1_10_v3_run_invalid');
  const outputPromise = observePromiseField(rawRun, 'output');
  const messages = requireAsyncIterable(
    readRequiredField(rawRun, 'messages', 'deep_agents_1_10_v3_run_messages_async_iterable_missing'),
    'deep_agents_1_10_v3_run_messages_async_iterable_missing'
  );
  const toolCalls = requireAsyncIterable(
    readRequiredField(rawRun, 'toolCalls', 'deep_agents_1_10_v3_run_tool_calls_async_iterable_missing'),
    'deep_agents_1_10_v3_run_tool_calls_async_iterable_missing'
  );
  const subagents = requireAsyncIterable(
    readRequiredField(rawRun, 'subagents', 'deep_agents_1_10_v3_run_subagents_async_iterable_missing'),
    'deep_agents_1_10_v3_run_subagents_async_iterable_missing'
  );
  const output = adaptObservedPromise(
    outputPromise,
    'deep_agents_1_10_v3_run_output_promise_missing',
    (value) => adaptOutput(value, 'run')
  );

  return {
    events: translateRunEvents({
      messages,
      projectToolOutput: options.projectToolOutput,
      rawRun,
      subagents,
      toolCalls
    }),
    output
  };
}

async function* translateRunEvents(input: {
  rawRun: Record<string, unknown>;
  messages: AsyncIterable<unknown>;
  toolCalls: AsyncIterable<unknown>;
  subagents: AsyncIterable<unknown>;
  projectToolOutput: ToolOutputProjector;
}): AsyncGenerator<DeepAgentDomainEvent> {
  const messages = adaptMessages(input.messages, 'run');
  const toolCalls = adaptToolCalls(input.toolCalls);
  const subagents = adaptSubagents(input.subagents, 'run');
  yield* mergeAsyncIterables([
    translateMessages(messages, null),
    translateToolCalls(toolCalls, null, input.projectToolOutput),
    translateSubagents(subagents, input.projectToolOutput)
  ]);

  if (readRunInterrupted(input.rawRun)) {
    yield {
      type: 'run_interrupted',
      interrupts: readRunInterrupts(input.rawRun)
    };
  }
}

async function* translateMessages(
  messages: AsyncIterable<DeepAgents110V3Message>,
  scope: DeepAgentSubagentScope | null
): AsyncGenerator<DeepAgentDomainEvent> {
  let reasoningObserved = false;
  for await (const message of messages) {
    let messageReasoningObserved = false;
    const streams: AsyncIterable<DeepAgentDomainEvent>[] = [
      translateUsage(message.usageKey, message.usage),
      scope === null
        ? translateVisibleText(message.reasoning, 'reasoning', scope)
        : drainStrings(message.reasoning),
      translateVisibleText(message.text, 'text', scope)
    ];
    for await (const event of mergeAsyncIterables(streams)) {
      if (event.type === 'assistant_delta' && event.scope === scope && event.kind === 'reasoning') {
        messageReasoningObserved = true;
        reasoningObserved = true;
      }
      yield event;
    }
    const trailingReasoning = await message.trailingReasoning;
    if (scope === null && !reasoningObserved && !messageReasoningObserved && trailingReasoning !== null) {
      yield* translateVisibleText(singleString(trailingReasoning), 'reasoning', scope);
    }
  }
}

async function* translateUsage(
  usageKey: string,
  usage: AsyncIterable<TokenUsage>
): AsyncGenerator<DeepAgentDomainEvent> {
  for await (const observation of usage) {
    yield {
      type: 'usage',
      usageKey,
      usage: observation
    };
  }
}

async function* drainStrings(
  values: AsyncIterable<string>
): AsyncGenerator<DeepAgentDomainEvent> {
  for await (const _value of values) {
    void _value;
  }
}

async function* translateVisibleText(
  stream: AsyncIterable<string>,
  kind: 'text' | 'reasoning',
  scope: DeepAgentSubagentScope | null
): AsyncGenerator<DeepAgentDomainEvent> {
  let pending = '';
  let released = false;
  let suppressMessage = false;

  for await (const delta of stream) {
    if (delta.length === 0 || suppressMessage) {
      continue;
    }
    if (released) {
      yield { type: 'assistant_delta', scope, kind, text: delta };
      continue;
    }
    pending += delta;
    const classification = recordUtils.classifyStreamedAssistantText(pending);
    if (classification === 'non_assistant') {
      pending = '';
      suppressMessage = true;
      continue;
    }
    if (classification === 'pending') {
      continue;
    }
    released = true;
    if (pending.length > 0) {
      yield { type: 'assistant_delta', scope, kind, text: pending };
    }
    pending = '';
  }

  if (!released && !suppressMessage && pending.length > 0) {
    yield { type: 'assistant_delta', scope, kind, text: pending };
  }
}

async function* translateToolCalls(
  calls: AsyncIterable<DeepAgents110V3ToolCall>,
  scope: DeepAgentSubagentScope | null,
  projectToolOutput: ToolOutputProjector
): AsyncGenerator<DeepAgentDomainEvent> {
  for await (const call of calls) {
    yield* projectToolCallLifecycle(call, scope, projectToolOutput);
  }
}

async function* projectToolCallLifecycle(
  call: DeepAgents110V3ToolCall,
  scope: DeepAgentSubagentScope | null,
  projectToolOutput: ToolOutputProjector
): AsyncGenerator<DeepAgentDomainEvent> {
  const outcomeSettlement = Promise.allSettled([call.outcome] as const);
  const input = redactUnknown(call.input);
  yield {
    type: 'tool_call_started',
    scope,
    callId: call.callId,
    name: call.name,
    input
  };

  const [settledOutcome] = await outcomeSettlement;
  if (settledOutcome.status === 'rejected') {
    const error = settledOutcome.reason;
    if (error instanceof DeepAgents110V3ContractError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Tool 执行失败。';
    yield {
      type: 'tool_call_failed',
      scope,
      callId: call.callId,
      name: call.name,
      input,
      error: projectToolOutput({
        callId: call.callId,
        name: call.name,
        output: redact(message)
      })
    };
    return;
  }
  const outcome = settledOutcome.value;
  if (outcome.status === 'error') {
    yield {
      type: 'tool_call_failed',
      scope,
      callId: call.callId,
      name: call.name,
      input,
      error: projectToolOutput({
        callId: call.callId,
        name: call.name,
        output: redact(outcome.error)
      })
    };
    return;
  }
  yield {
    type: 'tool_call_completed',
    scope,
    callId: call.callId,
    name: call.name,
    input,
    output: projectToolOutput({
      callId: call.callId,
      name: call.name,
      output: outcome.output
    })
  };
}

async function* translateSubagents(
  subagents: AsyncIterable<DeepAgents110V3Subagent>,
  projectToolOutput: ToolOutputProjector,
  parentScope: DeepAgentSubagentScope | null = null
): AsyncGenerator<DeepAgentDomainEvent> {
  let ordinal = 0;
  for await (const subagent of subagents) {
    const ordinalPath = parentScope === null
      ? [ordinal]
      : [...parentScope.ordinalPath, ordinal];
    const path = parentScope === null
      ? [`${subagent.name}#${ordinal}`]
      : [...parentScope.path, `${subagent.name}#${ordinal}`];
    const scope: DeepAgentSubagentScope = {
      name: subagent.name,
      ordinalPath,
      path
    };
    const outputSettlement = Promise.allSettled([subagent.output] as const);
    yield { type: 'subagent_started', scope };
    yield* mergeAsyncIterables([
      translateMessages(subagent.messages, scope),
      translateToolCalls(subagent.toolCalls, scope, projectToolOutput),
      translateSubagents(subagent.subagents, projectToolOutput, scope)
    ]);
    const [settledOutput] = await outputSettlement;
    if (settledOutput.status === 'rejected') {
      const error = settledOutput.reason;
      if (error instanceof DeepAgents110V3ContractError) {
        throw error;
      }
      yield {
        type: 'subagent_failed',
        scope,
        error: redact(error instanceof Error ? error.message : String(error))
      };
    } else {
      yield { type: 'subagent_completed', scope };
    }
    ordinal += 1;
  }
}

type SettledIteratorResult<T> =
  | { index: number; status: 'fulfilled'; result: IteratorResult<T> }
  | { index: number; status: 'rejected'; reason: unknown };

async function* mergeAsyncIterables<T>(
  streams: readonly AsyncIterable<T>[]
): AsyncGenerator<T> {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<SettledIteratorResult<T>>>();
  const schedule = (index: number): void => {
    const iterator = iterators[index];
    if (iterator === undefined) {
      return;
    }
    pending.set(
      index,
      Promise.resolve()
        .then(() => iterator.next())
        .then(
          (result) => ({ index, status: 'fulfilled' as const, result }),
          (reason: unknown) => ({ index, status: 'rejected' as const, reason })
        )
    );
  };
  iterators.forEach((_iterator, index) => schedule(index));
  let completed = false;
  try {
    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.index);
      if (settled.status === 'rejected') {
        throw settled.reason;
      }
      if (settled.result.done) {
        continue;
      }
      yield settled.result.value;
      schedule(settled.index);
    }
    completed = true;
  } finally {
    if (!completed) {
      const cleanups = iterators.map((iterator) =>
        typeof iterator.return === 'function' ? Promise.resolve(iterator.return()) : Promise.resolve()
      );
      void Promise.allSettled(cleanups);
    }
  }
}

function adaptMessages(
  messages: AsyncIterable<unknown>,
  parentPath: string
): AsyncIterable<DeepAgents110V3Message> {
  return mapAsyncIterable(messages, (message, ordinal) =>
    adaptMessage(message, `${parentPath}/messages/${ordinal}`)
  );
}

function adaptMessage(message: unknown, usageKey: string): DeepAgents110V3Message {
  const rawMessage = requireRecord(message, 'deep_agents_1_10_v3_message_invalid');
  const outputPromise = observePromiseField(rawMessage, 'output');
  const namespaceValue = readRequiredField(
    rawMessage,
    'namespace',
    'deep_agents_1_10_v3_message_namespace_invalid'
  );
  if (!Array.isArray(namespaceValue) || !namespaceValue.every((segment) => isNonEmptyString(segment))) {
    throw contractError('deep_agents_1_10_v3_message_namespace_invalid');
  }
  requireNonEmptyString(
    readRequiredField(rawMessage, 'node', 'deep_agents_1_10_v3_message_node_missing'),
    'deep_agents_1_10_v3_message_node_missing'
  );
  const text = requireAsyncIterable(
    readRequiredField(rawMessage, 'text', 'deep_agents_1_10_v3_message_text_async_iterable_missing'),
    'deep_agents_1_10_v3_message_text_async_iterable_missing'
  );
  requireAsyncIterable(
    readRequiredField(rawMessage, 'toolCalls', 'deep_agents_1_10_v3_message_tool_calls_async_iterable_missing'),
    'deep_agents_1_10_v3_message_tool_calls_async_iterable_missing'
  );
  const reasoning = requireAsyncIterable(
    readRequiredField(rawMessage, 'reasoning', 'deep_agents_1_10_v3_message_reasoning_async_iterable_missing'),
    'deep_agents_1_10_v3_message_reasoning_async_iterable_missing'
  );
  const usage = requireAsyncIterable(
    readRequiredField(rawMessage, 'usage', 'deep_agents_1_10_v3_message_usage_async_iterable_missing'),
    'deep_agents_1_10_v3_message_usage_async_iterable_missing'
  );
  const trailingReasoning = adaptObservedPromise(
    outputPromise,
    'deep_agents_1_10_v3_message_output_promise_missing',
    (value) => recordUtils.readReasoningFromMessageOutput(
      requireRecord(value, 'deep_agents_1_10_v3_message_output_invalid')
    )
  );

  return {
    usageKey,
    text: adaptStringStream(text, 'deep_agents_1_10_v3_message_text_value_invalid'),
    reasoning: adaptStringStream(reasoning, 'deep_agents_1_10_v3_message_reasoning_value_invalid'),
    trailingReasoning,
    usage: mapAsyncIterable(usage, (value) => adaptUsage(value)),
  };
}

function adaptToolCalls(calls: AsyncIterable<unknown>): AsyncIterable<DeepAgents110V3ToolCall> {
  return mapAsyncIterable(calls, (call) => adaptToolCall(call));
}

function adaptToolCall(call: unknown): DeepAgents110V3ToolCall {
  const rawCall = requireRecord(call, 'deep_agents_1_10_v3_tool_call_invalid');
  const outputPromise = observePromiseField(rawCall, 'output');
  const statusPromise = observePromiseField(rawCall, 'status');
  const errorPromise = observePromiseField(rawCall, 'error');
  const name = requireNonEmptyString(
    readRequiredField(rawCall, 'name', 'deep_agents_1_10_v3_tool_call_name_missing'),
    'deep_agents_1_10_v3_tool_call_name_missing'
  );
  const callId = requireNonEmptyString(
    readRequiredField(rawCall, 'callId', 'deep_agents_1_10_v3_tool_call_id_missing'),
    'deep_agents_1_10_v3_tool_call_id_missing'
  );
  const input = readRequiredField(rawCall, 'input', 'deep_agents_1_10_v3_tool_call_input_missing');
  const output = adaptObservedPromise(
    outputPromise,
    'deep_agents_1_10_v3_tool_call_output_promise_missing',
    (value) => value
  );
  const status = adaptObservedPromise(
    statusPromise,
    'deep_agents_1_10_v3_tool_call_status_promise_missing',
    (value) => adaptToolCallStatus(value)
  );
  const error = adaptObservedPromise(
    errorPromise,
    'deep_agents_1_10_v3_tool_call_error_promise_missing',
    (value) => adaptToolCallError(value)
  );
  const outcome = adaptToolCallOutcome(output, status, error);
  observePromiseRejection(outcome);

  return {
    name,
    callId,
    input,
    outcome
  };
}

async function adaptToolCallOutcome(
  output: Promise<unknown>,
  status: Promise<DeepAgents110V3ToolCallStatus>,
  error: Promise<string | undefined>
): Promise<DeepAgents110V3ToolCallOutcome> {
  const outputOutcome = output.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  );
  const [terminalStatus, terminalError] = await Promise.all([status, error]);
  if (terminalStatus === 'error') {
    if (terminalError === undefined) {
      throw contractError('deep_agents_1_10_v3_tool_call_terminal_error_missing');
    }
    return { status: 'error', error: terminalError };
  }
  if (terminalStatus !== 'finished') {
    throw contractError('deep_agents_1_10_v3_tool_call_status_not_terminal');
  }
  if (terminalError !== undefined) {
    throw contractError('deep_agents_1_10_v3_tool_call_terminal_error_unexpected');
  }
  const settledOutput = await outputOutcome;
  if (settledOutput.status === 'rejected') {
    throw settledOutput.reason;
  }
  return { status: 'finished', output: settledOutput.value };
}

function adaptSubagents(
  subagents: AsyncIterable<unknown>,
  parentPath: string
): AsyncIterable<DeepAgents110V3Subagent> {
  return mapAsyncIterable(subagents, (subagent, ordinal) =>
    adaptSubagent(subagent, `${parentPath}/subagents/${ordinal}`)
  );
}

function adaptSubagent(subagent: unknown, path: string): DeepAgents110V3Subagent {
  const rawSubagent = requireRecord(subagent, 'deep_agents_1_10_v3_subagent_invalid');
  const outputPromise = observePromiseField(rawSubagent, 'output');
  const name = requireNonEmptyString(
    readRequiredField(rawSubagent, 'name', 'deep_agents_1_10_v3_subagent_name_missing'),
    'deep_agents_1_10_v3_subagent_name_missing'
  );
  adaptSubagentCause(
    readRequiredField(rawSubagent, 'cause', 'deep_agents_1_10_v3_subagent_cause_missing')
  );
  const messages = requireAsyncIterable(
    readRequiredField(rawSubagent, 'messages', 'deep_agents_1_10_v3_subagent_messages_async_iterable_missing'),
    'deep_agents_1_10_v3_subagent_messages_async_iterable_missing'
  );
  const toolCalls = requireAsyncIterable(
    readRequiredField(rawSubagent, 'toolCalls', 'deep_agents_1_10_v3_subagent_tool_calls_async_iterable_missing'),
    'deep_agents_1_10_v3_subagent_tool_calls_async_iterable_missing'
  );
  const nestedSubagents = requireAsyncIterable(
    readRequiredField(rawSubagent, 'subagents', 'deep_agents_1_10_v3_subagent_subagents_async_iterable_missing'),
    'deep_agents_1_10_v3_subagent_subagents_async_iterable_missing'
  );
  const output = adaptObservedPromise(
    outputPromise,
    'deep_agents_1_10_v3_subagent_output_promise_missing',
    (value) => adaptOutput(value, 'subagent')
  );

  return {
    name,
    output,
    messages: adaptMessages(messages, path),
    toolCalls: adaptToolCalls(toolCalls),
    subagents: adaptSubagents(nestedSubagents, path)
  };
}

function adaptSubagentCause(value: unknown): DeepAgents110V3SubagentCause | null {
  if (value === undefined) {
    return null;
  }
  const cause = requireRecord(value, 'deep_agents_1_10_v3_subagent_cause_invalid');
  if (readRequiredField(cause, 'type', 'deep_agents_1_10_v3_subagent_cause_type_invalid') !== 'toolCall') {
    throw contractError('deep_agents_1_10_v3_subagent_cause_type_invalid');
  }
  const toolCallId = requireNonEmptyString(
    readRequiredField(
      cause,
      'tool_call_id',
      'deep_agents_1_10_v3_subagent_cause_tool_call_id_missing'
    ),
    'deep_agents_1_10_v3_subagent_cause_tool_call_id_missing'
  );
  return { type: 'toolCall', toolCallId };
}

function adaptUsage(value: unknown): TokenUsage {
  const usage = requireRecord(value, 'deep_agents_1_10_v3_usage_invalid');
  const inputDetailsValue = readField(usage, 'input_token_details');
  const inputDetails =
    inputDetailsValue === undefined
      ? null
      : requireRecord(inputDetailsValue, 'deep_agents_1_10_v3_usage_input_token_details_invalid');
  const result: TokenUsage = {
    inputTokens: readOptionalNonNegativeInteger(
      usage,
      'input_tokens',
      'deep_agents_1_10_v3_usage_input_tokens_invalid'
    ),
    outputTokens: readOptionalNonNegativeInteger(
      usage,
      'output_tokens',
      'deep_agents_1_10_v3_usage_output_tokens_invalid'
    ),
    totalTokens: readOptionalNonNegativeInteger(
      usage,
      'total_tokens',
      'deep_agents_1_10_v3_usage_total_tokens_invalid'
    ),
    cacheReadTokens:
      inputDetails === null
        ? null
        : readOptionalNonNegativeInteger(
            inputDetails,
            'cache_read',
            'deep_agents_1_10_v3_usage_cache_read_tokens_invalid'
          ),
    cacheCreationTokens:
      inputDetails === null
        ? null
        : readOptionalNonNegativeInteger(
            inputDetails,
            'cache_creation',
            'deep_agents_1_10_v3_usage_cache_creation_tokens_invalid'
          )
  };
  if (Object.values(result).every((tokenCount) => tokenCount === null)) {
    throw contractError('deep_agents_1_10_v3_usage_empty');
  }
  return result;
}

function adaptOutput(value: unknown, owner: 'run' | 'subagent'): string | null {
  const output = requireRecord(value, `deep_agents_1_10_v3_${owner}_output_invalid`);
  const messages = readRequiredField(
    output,
    'messages',
    `deep_agents_1_10_v3_${owner}_output_messages_missing`
  );
  if (!Array.isArray(messages)) {
    throw contractError(`deep_agents_1_10_v3_${owner}_output_messages_missing`);
  }
  const adaptedMessages = messages.map((message) =>
    requireRecord(message, `deep_agents_1_10_v3_${owner}_output_message_invalid`)
  );
  const lastMessage = adaptedMessages.at(-1);
  return lastMessage === undefined ? null : readAssistantMessageText(lastMessage);
}

function readAssistantMessageText(message: Record<string, unknown>): string | null {
  if (!isAssistantMessage(message)) {
    return null;
  }
  if (recordUtils.isNonAssistantTextMessage(message) || recordUtils.isSummarizationMessage(message)) {
    return null;
  }
  const contentSummary = recordUtils.readMessageContentSummary(message);
  if (!contentSummary.hasVisibleText) {
    return null;
  }
  const trimmed = contentSummary.visibleText.trim();
  if (recordUtils.classifyStreamedAssistantText(trimmed) !== 'assistant') {
    return null;
  }
  return trimmed.length === 0 ? null : trimmed;
}

function isAssistantMessage(message: Record<string, unknown>): boolean {
  const role = readLowercaseString(recordUtils.readRecordValue(message, 'role'));
  if (role !== null) {
    return role === 'assistant' || role === 'ai';
  }
  const type = readLowercaseString(recordUtils.readRecordValue(message, 'type'));
  return type === 'assistant' || type === 'ai' || type === 'aimessage';
}

function readLowercaseString(value: unknown): string | null {
  const text = recordUtils.readNonEmptyString(value);
  return text === null ? null : text.toLowerCase();
}

function adaptInterrupt(value: unknown): DeepAgentInterrupt {
  const interrupt = requireRecord(value, 'deep_agents_1_10_v3_run_interrupt_invalid');
  const interruptId = requireNonEmptyString(
    readRequiredField(interrupt, 'interruptId', 'deep_agents_1_10_v3_run_interrupt_id_missing'),
    'deep_agents_1_10_v3_run_interrupt_id_missing'
  );
  const payload = readRequiredField(
    interrupt,
    'payload',
    'deep_agents_1_10_v3_run_interrupt_payload_missing'
  );
  return { interruptId, payload };
}

function readRunInterrupted(run: Record<string, unknown>): boolean {
  const interrupted = readRequiredField(
    run,
    'interrupted',
    'deep_agents_1_10_v3_run_interrupted_boolean_missing'
  );
  if (typeof interrupted !== 'boolean') {
    throw contractError('deep_agents_1_10_v3_run_interrupted_boolean_missing');
  }
  return interrupted;
}

function readRunInterrupts(run: Record<string, unknown>): readonly DeepAgentInterrupt[] {
  const interrupts = readRequiredField(
    run,
    'interrupts',
    'deep_agents_1_10_v3_run_interrupts_array_missing'
  );
  if (!Array.isArray(interrupts)) {
    throw contractError('deep_agents_1_10_v3_run_interrupts_array_missing');
  }
  return interrupts.map((interrupt) => adaptInterrupt(interrupt));
}

function adaptStringStream(values: AsyncIterable<unknown>, errorCode: string): AsyncIterable<string> {
  return mapAsyncIterable(values, (value) => {
    if (typeof value !== 'string') {
      throw contractError(errorCode);
    }
    return value;
  });
}

function adaptToolCallStatus(value: unknown): DeepAgents110V3ToolCallStatus {
  if (value !== 'running' && value !== 'finished' && value !== 'error') {
    throw contractError('deep_agents_1_10_v3_tool_call_status_invalid');
  }
  return value;
}

function adaptToolCallError(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw contractError('deep_agents_1_10_v3_tool_call_error_invalid');
  }
  return value;
}

function adaptObservedPromise<T>(
  observed: Promise<unknown> | null,
  missingCode: string,
  project: (resolved: unknown) => T | PromiseLike<T>
): Promise<T> {
  if (observed === null) {
    throw contractError(missingCode);
  }
  const adapted = observed.then((resolved) => project(resolved));
  observePromiseRejection(adapted);
  return adapted;
}

function observePromiseField(value: Record<string, unknown>, key: string): Promise<unknown> | null {
  const candidate = readField(value, key);
  if (!isPromiseLike(candidate)) {
    return null;
  }
  const observed = Promise.resolve(candidate);
  observePromiseRejection(observed);
  return observed;
}

function observePromiseRejection<T>(promise: Promise<T>): void {
  void Promise.allSettled([promise]);
}

async function* mapAsyncIterable<T>(
  values: AsyncIterable<unknown>,
  project: (value: unknown, ordinal: number) => T
): AsyncIterable<T> {
  let ordinal = 0;
  for await (const value of values) {
    yield project(value, ordinal);
    ordinal += 1;
  }
}

function requireRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw contractError(errorCode);
  }
  return value as Record<string, unknown>;
}

function readRequiredField(value: Record<string, unknown>, key: string, errorCode: string): unknown {
  if (!(key in value)) {
    throw contractError(errorCode);
  }
  return Reflect.get(value, key);
}

function readField(value: Record<string, unknown>, key: string): unknown {
  return Reflect.get(value, key);
}

function requireAsyncIterable(value: unknown, errorCode: string): AsyncIterable<unknown> {
  if (!isAsyncIterable(value)) {
    throw contractError(errorCode);
  }
  return value;
}

function requireNonEmptyString(value: unknown, errorCode: string): string {
  if (!isNonEmptyString(value)) {
    throw contractError(errorCode);
  }
  return value;
}

function readOptionalNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
  errorCode: string
): number | null {
  const candidate = readField(value, key);
  if (candidate === undefined) {
    return null;
  }
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
    throw contractError(errorCode);
  }
  return candidate;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isObjectLike(value) && typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObjectLike(value) && typeof Reflect.get(value, 'then') === 'function';
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function* singleString(value: string): AsyncGenerator<string> {
  yield value;
}

function contractError(code: string): DeepAgents110V3ContractError {
  return new DeepAgents110V3ContractError(code);
}
