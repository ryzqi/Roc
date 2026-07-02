import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  FORGE_COMPACTION_PRIORITY,
  FORGE_TRANSIENT_TYPES,
  isForgeTransientMessage,
  readForgeMessageTag,
  tagForgeMessage,
  type ForgeMessageType
} from '../../../../src/main/services/forge-guardrails/message-tags';

const REMOVED_STEP_TAG = ['forge', 'step_nudge'].join(':');
const REMOVED_PREREQUISITE_TAG = ['forge', 'prerequisite_nudge'].join(':');

describe('forge message tags', () => {
  it('writes and reads forge message tags through additional_kwargs', () => {
    const message = new HumanMessage('x');

    tagForgeMessage(message, 'forge:retry_nudge');

    expect(readForgeMessageTag(message)).toBe('forge:retry_nudge');
  });

  it('returns null when no valid tag exists', () => {
    expect(readForgeMessageTag(new HumanMessage('x'))).toBeNull();

    const invalid = new HumanMessage({ content: 'x', additional_kwargs: { forge_message_type: 'invalid' } });
    expect(readForgeMessageTag(invalid)).toBeNull();
    expect(
      readForgeMessageTag(new HumanMessage({ content: 'x', additional_kwargs: { forge_message_type: REMOVED_STEP_TAG } }))
    ).toBeNull();
    expect(
      readForgeMessageTag(
        new HumanMessage({ content: 'x', additional_kwargs: { forge_message_type: REMOVED_PREREQUISITE_TAG } })
      )
    ).toBeNull();
  });

  it('classifies only transient nudge tags as cross-turn filtered', () => {
    for (const type of FORGE_TRANSIENT_TYPES) {
      expect(isForgeTransientMessage(tagForgeMessage(new HumanMessage('x'), type))).toBe(true);
    }

    const persistentTypes: ForgeMessageType[] = [
      'forge:reasoning',
      'forge:tool_resolution',
      'forge:context_digest'
    ];
    for (const type of persistentTypes) {
      expect(isForgeTransientMessage(tagForgeMessage(new HumanMessage('x'), type))).toBe(false);
    }
  });

  it('overwrites an existing tag on the same message object', () => {
    const message = new HumanMessage('x');

    const first = tagForgeMessage(message, 'forge:retry_nudge');
    const second = tagForgeMessage(message, 'forge:reasoning');

    expect(second).toBe(first);
    expect(readForgeMessageTag(message)).toBe('forge:reasoning');
  });

  it('mutates the existing additional_kwargs object instead of replacing the message', () => {
    const kwargs: Record<string, unknown> = { existing: true };
    const message = new HumanMessage({ content: 'x', additional_kwargs: kwargs });

    const result = tagForgeMessage(message, 'forge:context_warning');

    expect(result).toBe(message);
    expect(message.additional_kwargs).toBe(kwargs);
    expect(kwargs).toMatchObject({
      existing: true,
      forge_message_type: 'forge:context_warning'
    });
  });

  it('keeps the compaction priority table stable', () => {
    expect(FORGE_COMPACTION_PRIORITY).toEqual({
      'forge:retry_nudge': 1,
      'forge:unknown_tool_nudge': 1,
      'forge:context_warning': 1,
      'forge:tool_resolution': 2,
      'forge:reasoning': 4,
      'forge:context_digest': 0
    });
  });
});
