import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

import {
  markIterationOnMessage,
  readIterationFromMessage
} from './state-schema';
import {
  readForgeMessageTag,
  tagForgeMessage
} from './message-tags';

export type RocContextDigest = {
  facts: string[];
  decisions: string[];
  filesTouched: string[];
  verifications: string[];
  openQuestions: string[];
  nextActions: string[];
};

const DIGEST_MESSAGE_ID = 'roc-context-digest';
const MAX_ITEMS_PER_FIELD = 8;

export function createEmptyContextDigest(): RocContextDigest {
  return {
    facts: [],
    decisions: [],
    filesTouched: [],
    verifications: [],
    openQuestions: [],
    nextActions: []
  };
}

export function createContextDigestMessage(digest: RocContextDigest): AIMessage {
  const message = new AIMessage({
    id: DIGEST_MESSAGE_ID,
    content: serializeDigest(digest),
    additional_kwargs: {
      roc_context_digest: digest
    }
  });
  return tagForgeMessage(message, 'forge:context_digest');
}

export function isContextDigestMessage(message: BaseMessage): message is AIMessage {
  return AIMessage.isInstance(message) && readForgeMessageTag(message) === 'forge:context_digest';
}

export function refreshContextDigestMessage(messages: BaseMessage[], keepRecent: number): void {
  const eligibleEnd = findEligibleEnd(messages, keepRecent);
  if (eligibleEnd <= 0) {
    return;
  }
  const digest = createEmptyContextDigest();
  for (let index = 0; index < eligibleEnd; index += 1) {
    const message = messages[index];
    if (message === undefined || isContextDigestMessage(message)) {
      continue;
    }
    mergeDigest(digest, digestFromMessage(message));
  }
  if (isEmptyDigest(digest)) {
    return;
  }
  const existingIndex = messages.findIndex(isContextDigestMessage);
  const digestMessage = markIterationOnMessage(createContextDigestMessage(digest), 0);
  if (existingIndex === -1) {
    const first = messages[0];
    const insertIndex = first !== undefined && first.getType() === 'system' ? 1 : 0;
    messages.splice(insertIndex, 0, digestMessage);
    return;
  }
  messages[existingIndex] = digestMessage;
}

function digestFromMessage(message: BaseMessage): RocContextDigest {
  const digest = createEmptyContextDigest();
  if (AIMessage.isInstance(message) && typeof message.content === 'string') {
    collectAssistantText(digest, message.content);
  }
  if (ToolMessage.isInstance(message)) {
    collectToolMessage(digest, message);
  }
  return digest;
}

function collectAssistantText(digest: RocContextDigest, content: string): void {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    collectPrefixedLine(digest.decisions, line, 'Decision:');
    collectPrefixedLine(digest.nextActions, line, 'Next:');
    collectPrefixedLine(digest.openQuestions, line, 'Question:');
    collectPrefixedLine(digest.facts, line, 'Fact:');
  }
}

function collectPrefixedLine(target: string[], line: string, prefix: string): void {
  if (!line.startsWith(prefix)) {
    return;
  }
  addUnique(target, line.slice(prefix.length).trim());
}

function collectToolMessage(digest: RocContextDigest, message: ToolMessage): void {
  if (!isVerificationTool(message.name)) {
    return;
  }
  const content = String(message.content);
  if (!containsVerificationSignal(content)) {
    return;
  }
  addUnique(digest.verifications, `${message.name}: ${content.slice(0, 200)}`);
  const fileMatches = content.match(/[A-Za-z]:\\[^\s'"<>|]+|\/workspace\/[^\s'"<>|]+/gu);
  if (fileMatches === null) {
    return;
  }
  for (const match of fileMatches) {
    addUnique(digest.filesTouched, match);
  }
}

function isVerificationTool(name: string | undefined): name is string {
  return name === 'run_shell_command' || name === 'shell.execute';
}

function containsVerificationSignal(content: string): boolean {
  return /\b(PASS|FAIL|passed|failed|pnpm test|pnpm typecheck|git diff --check)\b/u.test(content);
}

function mergeDigest(target: RocContextDigest, source: RocContextDigest): void {
  mergeItems(target.facts, source.facts);
  mergeItems(target.decisions, source.decisions);
  mergeItems(target.filesTouched, source.filesTouched);
  mergeItems(target.verifications, source.verifications);
  mergeItems(target.openQuestions, source.openQuestions);
  mergeItems(target.nextActions, source.nextActions);
}

function mergeItems(target: string[], source: readonly string[]): void {
  for (const item of source) {
    addUnique(target, item);
  }
}

function addUnique(target: string[], value: string): void {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0 || target.includes(normalized) || target.length >= MAX_ITEMS_PER_FIELD) {
    return;
  }
  target.push(normalized);
}

function isEmptyDigest(digest: RocContextDigest): boolean {
  return (
    digest.facts.length === 0 &&
    digest.decisions.length === 0 &&
    digest.filesTouched.length === 0 &&
    digest.verifications.length === 0 &&
    digest.openQuestions.length === 0 &&
    digest.nextActions.length === 0
  );
}

function serializeDigest(digest: RocContextDigest): string {
  return [
    '<roc_context_digest>',
    serializeSection('facts', digest.facts),
    serializeSection('decisions', digest.decisions),
    serializeSection('filesTouched', digest.filesTouched),
    serializeSection('verifications', digest.verifications),
    serializeSection('openQuestions', digest.openQuestions),
    serializeSection('nextActions', digest.nextActions),
    '</roc_context_digest>'
  ].join('\n');
}

function serializeSection(name: keyof RocContextDigest, values: readonly string[]): string {
  if (values.length === 0) {
    return `<${name} />`;
  }
  return [`<${name}>`, ...values.map((value) => `- ${value}`), `</${name}>`].join('\n');
}

function findEligibleEnd(messages: BaseMessage[], keepRecent: number): number {
  let maxIteration = -1;
  for (const message of messages) {
    const iterationIndex = readIterationFromMessage(message);
    if (iterationIndex !== null && iterationIndex > maxIteration) {
      maxIteration = iterationIndex;
    }
  }
  if (maxIteration < 0) {
    return 0;
  }
  const keepThreshold = maxIteration - keepRecent;
  if (keepThreshold < 0) {
    return 0;
  }
  for (let index = 0; index < messages.length; index += 1) {
    const iterationIndex = readIterationFromMessage(messages[index]!);
    if (iterationIndex !== null && iterationIndex > keepThreshold) {
      return index;
    }
  }
  return messages.length;
}
