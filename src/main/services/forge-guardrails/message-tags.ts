import type { BaseMessage } from '@langchain/core/messages';

export type ForgeMessageType =
  | 'forge:retry_nudge'
  | 'forge:unknown_tool_nudge'
  | 'forge:tool_resolution'
  | 'forge:reasoning'
  | 'forge:context_warning';

const TAG_KEY = 'forge_message_type';
const NUDGE_VISIBILITY_KEY = 'forge_nudge_visibility';

export type ForgeNudgeVisibility = 'internal' | 'visible';

export function createForgeMessageId(kind: string, sourceId: string): string {
  const normalizedKind = normalizeIdPart(kind);
  const normalizedSource = normalizeIdPart(sourceId);
  return `forge-${normalizedKind}-${normalizedSource}`;
}

export function tagForgeMessage<M extends BaseMessage>(message: M, type: ForgeMessageType): M {
  const kwargs = (message.additional_kwargs ??= {});
  kwargs[TAG_KEY] = type;
  return message;
}

export function markForgeNudgeInternal<M extends BaseMessage>(message: M): M {
  const kwargs = (message.additional_kwargs ??= {});
  kwargs[NUDGE_VISIBILITY_KEY] = 'internal';
  return message;
}

export function readForgeMessageTag(message: BaseMessage): ForgeMessageType | null {
  const value = message.additional_kwargs?.[TAG_KEY];
  return isForgeMessageType(value) ? value : null;
}

export function readForgeNudgeVisibility(message: BaseMessage): ForgeNudgeVisibility {
  return message.additional_kwargs?.[NUDGE_VISIBILITY_KEY] === 'internal' ? 'internal' : 'visible';
}

function isForgeMessageType(value: unknown): value is ForgeMessageType {
  return (
    value === 'forge:retry_nudge' ||
    value === 'forge:unknown_tool_nudge' ||
    value === 'forge:tool_resolution' ||
    value === 'forge:reasoning' ||
    value === 'forge:context_warning'
  );
}

export const FORGE_TRANSIENT_TYPES: ReadonlySet<ForgeMessageType> = new Set([
  'forge:retry_nudge',
  'forge:unknown_tool_nudge',
  'forge:context_warning'
]);

export function isForgeTransientMessage(message: BaseMessage): boolean {
  const tag = readForgeMessageTag(message);
  return tag !== null && FORGE_TRANSIENT_TYPES.has(tag);
}

function normalizeIdPart(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Forge message id parts must not be empty.');
  }
  return trimmed.replace(/[^A-Za-z0-9_.:-]/g, '_');
}

export const FORGE_COMPACTION_PRIORITY: Record<ForgeMessageType, number> = {
  'forge:retry_nudge': 1,
  'forge:unknown_tool_nudge': 1,
  'forge:context_warning': 1,
  'forge:tool_resolution': 2,
  'forge:reasoning': 4
};
