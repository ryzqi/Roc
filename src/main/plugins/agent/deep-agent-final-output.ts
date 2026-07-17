import type { HITLRequest } from 'langchain';

import type { ChatInterruptPayload, ChatQuestionInterruptPayload, ChatRunEvent } from '../../../shared/types';
import * as recordUtils from '../../services/deep-agent/record-utils';

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
  if (typeof interruptId !== 'string') {
    throw new Error('agent_interrupt_payload_invalid');
  }
  return {
    type: 'run_interrupted',
    runId,
    threadId,
    interruptId,
    payload: normalizeInterruptPayload(payload)
  };
}

function normalizeInterruptPayload(payload: unknown): ChatInterruptPayload {
  if (isQuestionInterruptPayload(payload)) {
    return payload;
  }
  if (isApprovalRequest(payload)) {
    return {
      kind: 'approval',
      request: payload
    };
  }
  throw new Error('agent_interrupt_payload_invalid');
}

function isQuestionInterruptPayload(value: unknown): value is ChatQuestionInterruptPayload {
  if (!recordUtils.isRecord(value)) {
    return false;
  }
  if (recordUtils.readRecordValue(value, 'kind') !== 'question') {
    return false;
  }
  return typeof recordUtils.readRecordValue(value, 'question') === 'string';
}

function isApprovalRequest(value: unknown): value is HITLRequest {
  if (!recordUtils.isRecord(value)) {
    return false;
  }
  return Array.isArray(recordUtils.readRecordValue(value, 'actionRequests')) && Array.isArray(recordUtils.readRecordValue(value, 'reviewConfigs'));
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

