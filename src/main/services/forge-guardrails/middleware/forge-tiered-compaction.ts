import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { contextEditingMiddleware, type ContextEdit } from 'langchain';
import {
  isContextDigestMessage,
  refreshContextDigestMessage
} from '../context-digest';
import { isForgeTransientMessage, readForgeMessageTag } from '../message-tags';
import { readIterationFromMessage } from '../state-schema';

const PROTECTED_HEADER_COUNT = 1;
const DEFAULT_BUDGET_TOKENS = 7168;
const DEFAULT_KEEP_RECENT = 2;
const DEFAULT_PHASE_THRESHOLDS: readonly [number, number, number] = [0.6, 0.75, 0.9];
const TRUNCATE_CHARS = 200;

export type ForgeTieredCompactionOptions = {
  budgetTokens?: number;
  keepRecent?: number;
  phaseThresholds?: readonly [number, number, number];
};

type RequiredForgeTieredCompactionOptions = {
  budgetTokens: number;
  keepRecent: number;
  phaseThresholds: readonly [number, number, number];
};

export function createForgeTieredCompactionMiddleware(opts: ForgeTieredCompactionOptions = {}) {
  return contextEditingMiddleware({
    edits: createForgeTieredCompactionEdits(opts),
    tokenCountMethod: 'approx'
  });
}

export function createForgeTieredCompactionEdits(opts: ForgeTieredCompactionOptions): ContextEdit[] {
  const resolved = resolveOptions(opts);
  return [
    new ThresholdedEdit(resolved.budgetTokens, resolved.phaseThresholds[0], resolved.keepRecent, [
      new ForgeDropNudgesEdit(resolved.keepRecent),
      new ForgeTruncateToolResultsEdit(resolved.keepRecent)
    ]),
    new ThresholdedEdit(resolved.budgetTokens, resolved.phaseThresholds[1], resolved.keepRecent, [
      new ForgeDropToolResultsEdit(resolved.keepRecent)
    ]),
    new ThresholdedEdit(resolved.budgetTokens, resolved.phaseThresholds[2], resolved.keepRecent, [
      new ForgeDropReasoningTextEdit(resolved.keepRecent)
    ])
  ];
}

function resolveOptions(opts: ForgeTieredCompactionOptions): RequiredForgeTieredCompactionOptions {
  return {
    budgetTokens: opts.budgetTokens === undefined ? DEFAULT_BUDGET_TOKENS : opts.budgetTokens,
    keepRecent: opts.keepRecent === undefined ? DEFAULT_KEEP_RECENT : opts.keepRecent,
    phaseThresholds: opts.phaseThresholds === undefined ? DEFAULT_PHASE_THRESHOLDS : opts.phaseThresholds
  };
}

function findEligibleEnd(messages: BaseMessage[], keepRecent: number): number {
  let maxIteration = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const iterationIndex = readIterationFromMessage(messages[index]!);
    if (iterationIndex !== null && iterationIndex > maxIteration) {
      maxIteration = iterationIndex;
    }
  }
  if (maxIteration < 0) {
    return PROTECTED_HEADER_COUNT;
  }

  const keepThreshold = maxIteration - keepRecent;
  if (keepThreshold < 0) {
    return PROTECTED_HEADER_COUNT;
  }

  for (let index = PROTECTED_HEADER_COUNT; index < messages.length; index += 1) {
    const iterationIndex = readIterationFromMessage(messages[index]!);
    if (iterationIndex !== null && iterationIndex > keepThreshold) {
      return index;
    }
  }
  return messages.length;
}

class ThresholdedEdit implements ContextEdit {
  constructor(
    private readonly budgetTokens: number,
    private readonly threshold: number,
    private readonly keepRecent: number,
    private readonly edits: readonly ContextEdit[]
  ) {}

  async apply(params: { messages: BaseMessage[]; countTokens: (messages: BaseMessage[]) => Promise<number> }): Promise<void> {
    const tokens = await params.countTokens(params.messages);
    if (tokens < this.budgetTokens * this.threshold) {
      return;
    }
    refreshContextDigestMessage(params.messages, this.keepRecent);
    for (const edit of this.edits) {
      await edit.apply(params);
    }
  }
}

class ForgeDropNudgesEdit implements ContextEdit {
  constructor(private readonly keepRecent: number) {}

  async apply(params: { messages: BaseMessage[] }): Promise<void> {
    const cutoff = findEligibleEnd(params.messages, this.keepRecent);
    for (let index = cutoff - 1; index >= PROTECTED_HEADER_COUNT; index -= 1) {
      if (isForgeTransientMessage(params.messages[index]!)) {
        params.messages.splice(index, 1);
      }
    }
  }
}

class ForgeTruncateToolResultsEdit implements ContextEdit {
  constructor(private readonly keepRecent: number) {}

  async apply(params: { messages: BaseMessage[] }): Promise<void> {
    const cutoff = findEligibleEnd(params.messages, this.keepRecent);
    for (let index = PROTECTED_HEADER_COUNT; index < cutoff; index += 1) {
      const message = params.messages[index]!;
      if (isContextDigestMessage(message)) {
        continue;
      }
      if (!ToolMessage.isInstance(message)) {
        continue;
      }
      if (readForgeMessageTag(message) === 'forge:tool_resolution') {
        continue;
      }
      if (typeof message.content !== 'string' || message.content.length <= TRUNCATE_CHARS) {
        continue;
      }
      if (isAlreadyTruncated(message)) {
        continue;
      }

      const kept = message.content.slice(0, TRUNCATE_CHARS);
      const removed = message.content.length - TRUNCATE_CHARS;
      params.messages[index] = new ToolMessage({
        id: message.id,
        tool_call_id: message.tool_call_id,
        name: message.name,
        content: `${kept}\n[Truncated - ${removed} chars removed]`,
        status: message.status,
        artifact: message.artifact,
        additional_kwargs: message.additional_kwargs,
        response_metadata: {
          ...message.response_metadata,
          forge_compaction: {
            type: 'truncated_tool_result',
            removedChars: removed
          }
        },
        metadata: message.metadata
      });
    }
  }
}

class ForgeDropToolResultsEdit implements ContextEdit {
  constructor(private readonly keepRecent: number) {}

  async apply(params: { messages: BaseMessage[] }): Promise<void> {
    const cutoff = findEligibleEnd(params.messages, this.keepRecent);
    for (let index = cutoff - 1; index >= PROTECTED_HEADER_COUNT; index -= 1) {
      const message = params.messages[index]!;
      if (isContextDigestMessage(message)) {
        continue;
      }
      if (ToolMessage.isInstance(message) && readForgeMessageTag(message) !== 'forge:tool_resolution') {
        params.messages.splice(index, 1);
      }
    }
  }
}

class ForgeDropReasoningTextEdit implements ContextEdit {
  constructor(private readonly keepRecent: number) {}

  async apply(params: { messages: BaseMessage[] }): Promise<void> {
    const cutoff = findEligibleEnd(params.messages, this.keepRecent);
    for (let index = cutoff - 1; index >= PROTECTED_HEADER_COUNT; index -= 1) {
      const message = params.messages[index]!;
      if (isContextDigestMessage(message)) {
        continue;
      }
      const tag = readForgeMessageTag(message);
      if (tag === 'forge:reasoning') {
        params.messages.splice(index, 1);
        continue;
      }
      if (AIMessage.isInstance(message) && hasNoToolCalls(message)) {
        params.messages.splice(index, 1);
      }
    }
  }
}

function hasNoToolCalls(message: AIMessage): boolean {
  return message.tool_calls === undefined || message.tool_calls.length === 0;
}

function isAlreadyTruncated(message: ToolMessage): boolean {
  const compaction = message.response_metadata.forge_compaction;
  return (
    compaction !== null &&
    typeof compaction === 'object' &&
    (compaction as Record<string, unknown>).type === 'truncated_tool_result'
  );
}
