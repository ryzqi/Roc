import { describe, expect, it } from 'vitest';
import { CHAT_WINDOW_MIN_WIDTH, resolveChatWorkspaceScale } from '../../src/shared/chat-layout';

describe('chat layout scaling', () => {
  it('keeps desktop scale when the chat shell still has its baseline width', () => {
    expect(resolveChatWorkspaceScale({ availableWidth: 1280 })).toEqual({
      active: false,
      baseWidth: 1280,
      scale: 1
    });
  });

  it('shrinks the chat workspace against the shell baseline before reflow', () => {
    const scaled = resolveChatWorkspaceScale({ availableWidth: 896 });

    expect(scaled.baseWidth).toBe(1280);
    expect(scaled.active).toBe(true);
    expect(scaled.scale).toBeCloseTo(896 / 1280, 5);
  });

  it('publishes a chat-safe minimum window width above the legacy responsive breakpoint', () => {
    expect(CHAT_WINDOW_MIN_WIDTH).toBeGreaterThan(1180);
  });
});
