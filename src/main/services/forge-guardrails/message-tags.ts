import type { BaseMessage } from '@langchain/core/messages';

export type ForgeMessageType =
  | 'forge:retry_nudge'
  | 'forge:unknown_tool_nudge'
  | 'forge:tool_resolution'
  | 'forge:reasoning'
  | 'forge:context_warning'
  | 'forge:context_digest';

const TAG_KEY = 'forge_message_type';

export function tagForgeMessage<M extends BaseMessage>(message: M, type: ForgeMessageType): M {
  const kwargs = (message.additional_kwargs ??= {});
  kwargs[TAG_KEY] = type;
  return message;
}

export function readForgeMessageTag(message: BaseMessage): ForgeMessageType | null {
  const value = message.additional_kwargs?.[TAG_KEY];
  return isForgeMessageType(value) ? value : null;
}

function isForgeMessageType(value: unknown): value is ForgeMessageType {
  return (
    value === 'forge:retry_nudge' ||
    value === 'forge:unknown_tool_nudge' ||
    value === 'forge:tool_resolution' ||
    value === 'forge:reasoning' ||
    value === 'forge:context_warning' ||
    value === 'forge:context_digest'
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
