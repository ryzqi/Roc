import type { HITLRequest } from 'langchain';

import type { ChatInterruptPayload, ChatQuestionInterruptPayload, ChatRunEvent } from '../../../shared/types';
import type {
  DeepAgents110V3Output,
  DeepAgents110V3Run
} from '../../services/deep-agent/deep-agents-1-10-stream-adapter';
import * as recordUtils from '../../services/deep-agent/record-utils';

export function readInterrupted(run: Pick<DeepAgents110V3Run, 'interrupted'>): boolean {
  return run.interrupted;
}

export function readRunInterruptedEvents(
  run: Pick<DeepAgents110V3Run, 'interrupts'>,
  runId: string,
  threadId: string
): ChatRunEvent[] {
  if (run.interrupts.length === 0) {
    throw new Error('agent_interrupt_payload_missing');
  }
  return run.interrupts.map((interrupt) => {
    return {
      type: 'run_interrupted',
      runId,
      threadId,
      interruptId: interrupt.interruptId,
      payload: normalizeChatInterruptPayload(interrupt.payload)
    } satisfies ChatRunEvent;
  });
}

export function normalizeChatInterruptPayload(payload: unknown): ChatInterruptPayload {
  if (isQuestionInterruptPayload(payload)) {
    return payload;
  }
  if (isApprovalInterruptPayload(payload)) {
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

function isApprovalInterruptPayload(value: unknown): value is ChatInterruptPayload {
  if (!recordUtils.isRecord(value) || recordUtils.readRecordValue(value, 'kind') !== 'approval') {
    return false;
  }
  return isApprovalRequest(recordUtils.readRecordValue(value, 'request'));
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

export function readFinalAssistantText(output: DeepAgents110V3Output): string | null {
  return output.finalAssistantText;
}

