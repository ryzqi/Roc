import { describe, expect, it } from 'vitest';
import { CHAT_WINDOW_MIN_WIDTH, resolveChatWorkspaceScale } from '../../src/shared/chat-layout';

describe('chat layout scaling', () => {
  it('keeps desktop scale when the chat shell still has its baseline width', () => {
    expect(resolveChatWorkspaceScale({ availableWidth: 1032, chatSidebarCollapsed: false })).toEqual({
      active: false,
      baseWidth: 1032,
      scale: 1
    });
    expect(resolveChatWorkspaceScale({ availableWidth: 1280, chatSidebarCollapsed: true })).toEqual({
      active: false,
      baseWidth: 1280,
      scale: 1
    });
  });

  it('shrinks the chat workspace against the sidebar-aware shell baseline before reflow', () => {
    const expandedSidebar = resolveChatWorkspaceScale({ availableWidth: 896, chatSidebarCollapsed: false });
    const collapsedSidebar = resolveChatWorkspaceScale({ availableWidth: 1144, chatSidebarCollapsed: true });

    expect(expandedSidebar.baseWidth).toBe(1032);
    expect(expandedSidebar.active).toBe(true);
    expect(expandedSidebar.scale).toBeCloseTo(896 / 1032, 5);

    expect(collapsedSidebar.baseWidth).toBe(1280);
    expect(collapsedSidebar.active).toBe(true);
    expect(collapsedSidebar.scale).toBeCloseTo(1144 / 1280, 5);
  });

  it('publishes a chat-safe minimum window width above the legacy responsive breakpoint', () => {
    expect(CHAT_WINDOW_MIN_WIDTH).toBeGreaterThan(1180);
  });
});
