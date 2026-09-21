const CHAT_BASE_WINDOW_WIDTH = 1320;
const WORKSPACE_HORIZONTAL_PADDING = 40;
export const CHAT_WINDOW_MIN_WIDTH = 1184;

type ResolveChatWorkspaceScaleInput = {
  availableWidth: number;
};

type ChatWorkspaceScaleSnapshot = {
  active: boolean;
  baseWidth: number;
  scale: number;
};

export function resolveChatWorkspaceScale(
  input: ResolveChatWorkspaceScaleInput
): ChatWorkspaceScaleSnapshot {
  const baseWidth = CHAT_BASE_WINDOW_WIDTH - WORKSPACE_HORIZONTAL_PADDING;
  if (input.availableWidth <= 0 || input.availableWidth >= baseWidth) {
    return {
      active: false,
      baseWidth,
      scale: 1
    };
  }
  return {
    active: true,
    baseWidth,
    scale: Math.max(0.01, Math.round((input.availableWidth / baseWidth) * 100000) / 100000)
  };
}
