import { ToolMessage } from '@langchain/core/messages';

import type { ChatRunEvent } from '../../../shared/types';
import { readForgeMessageTag } from '../../services/forge-guardrails';
import * as recordUtils from '../../services/deep-agent/record-utils';

type FinalToolMessageBlock =
  | {
      callId: string;
      name: string;
      phase: 'end';
      output: unknown;
    }
  | {
      callId: string;
      name: string;
      phase: 'error';
      error: unknown;
    };

export function readInterrupted(run: unknown): boolean {
  return typeof run === 'object' && run !== null && Reflect.get(run, 'interrupted') === true;
}

export function readRunInterruptedEvent(run: unknown, runId: string, threadId: string): ChatRunEvent {
  const interrupts = typeof run === 'object' && run !== null ? Reflect.get(run, 'interrupts') : undefined;
  const firstInterrupt = Array.isArray(interrupts) ? interrupts[0] : undefined;
  if (typeof firstInterrupt !== 'object' || firstInterrupt === null) {
    throw new Error('agent_interrupt_payload_missing');
  }
  const interruptId = Reflect.get(firstInterrupt, 'interruptId');
  const payload = Reflect.get(firstInterrupt, 'payload');
  if (typeof interruptId !== 'string' || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('agent_interrupt_payload_invalid');
  }
  return {
    type: 'run_interrupted',
    runId,
    threadId,
    interruptId,
    payload: payload as never
  };
}

export function readFinalAssistantText(output: unknown): string | null {
  if (!recordUtils.isRecord(output)) {
    return null;
  }
  const messages = recordUtils.readRecordValue(output, 'messages');
  if (!Array.isArray(messages)) {
    return null;
  }
  const lastMessage = messages[messages.length - 1];
  if (lastMessage === undefined) {
    return null;
  }
  return readAssistantMessageText(lastMessage);
}

export function readFinalToolBlockEvents(output: unknown, runId: string): ChatRunEvent[] {
  if (!recordUtils.isRecord(output)) {
    return [];
  }
  const messages = recordUtils.readRecordValue(output, 'messages');
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.flatMap((message): ChatRunEvent[] => {
    const toolMessage = readFinalToolMessage(message);
    if (toolMessage === null) {
      return [];
    }
    return [
      {
        type: 'assistant_block',
        runId,
        block: {
          kind: 'tool_call',
          blockId: `tool-${toolMessage.callId}`,
          callId: toolMessage.callId,
          name: toolMessage.name,
          phase: toolMessage.phase,
          ...(toolMessage.phase === 'end'
            ? { output: toolMessage.output }
            : { error: toolMessage.error })
        }
      }
    ];
  });
}

function readFinalToolMessage(message: unknown): FinalToolMessageBlock | null {
  if (!isToolMessageLike(message)) {
    return null;
  }
  if (isForgeTaggedToolMessage(message)) {
    return null;
  }
  const callId = readToolMessageCallId(message);
  if (callId === null) {
    return null;
  }
  const name = readToolMessageName(message);
  if (name === null) {
    return null;
  }
  const output = readToolMessageOutput(message);
  if (readToolMessageStatus(message) === 'error') {
    return {
      callId,
      name,
      phase: 'error',
      error: output
    };
  }
  return {
    callId,
    name,
    phase: 'end',
    output
  };
}

function isForgeTaggedToolMessage(message: unknown): boolean {
  return ToolMessage.isInstance(message) && readForgeMessageTag(message) !== null;
}

function isToolMessageLike(message: unknown): boolean {
  if (ToolMessage.isInstance(message)) {
    return true;
  }
  if (!recordUtils.isRecord(message)) {
    return false;
  }
  const role = readLowercaseString(recordUtils.readRecordValue(message, 'role'));
  if (role !== null) {
    return role === 'tool';
  }
  const type = readLowercaseString(recordUtils.readRecordValue(message, 'type'));
  return type === 'tool' || type === 'toolmessage';
}

function readToolMessageCallId(message: unknown): string | null {
  if (ToolMessage.isInstance(message)) {
    return message.tool_call_id;
  }
  if (!recordUtils.isRecord(message)) {
    return null;
  }
  const snakeCase = recordUtils.readNonEmptyString(recordUtils.readRecordValue(message, 'tool_call_id'));
  if (snakeCase !== null) {
    return snakeCase;
  }
  return recordUtils.readNonEmptyString(recordUtils.readRecordValue(message, 'toolCallId'));
}

function readToolMessageName(message: unknown): string | null {
  if (ToolMessage.isInstance(message)) {
    return message.name === undefined ? null : message.name;
  }
  if (!recordUtils.isRecord(message)) {
    return null;
  }
  return recordUtils.readNonEmptyString(recordUtils.readRecordValue(message, 'name'));
}

function readToolMessageStatus(message: unknown): 'success' | 'error' | null {
  const status = ToolMessage.isInstance(message)
    ? message.status
    : recordUtils.isRecord(message)
      ? readLowercaseString(recordUtils.readRecordValue(message, 'status'))
      : null;
  return status === 'success' || status === 'error' ? status : null;
}

function readToolMessageOutput(message: unknown): unknown {
  if (ToolMessage.isInstance(message)) {
    return readToolContentValue(message.content);
  }
  if (!recordUtils.isRecord(message)) {
    return null;
  }
  return readToolContentValue(recordUtils.readRecordValue(message, 'content'));
}

function readToolContentValue(content: unknown): unknown {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const summary = recordUtils.readMessageContentSummary({ content });
    if (summary.hasVisibleText) {
      return summary.visibleText;
    }
  }
  return content;
}

function readAssistantMessageText(message: unknown): string | null {
  if (!recordUtils.isRecord(message) || !isAssistantMessage(message)) {
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

