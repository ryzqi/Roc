import type { CSSProperties, RefObject } from 'react';
import { useEffect, useState } from 'react';

import { resolveChatWorkspaceScale } from '../../shared/chat-layout';
import type { ViewId } from './types';

export function useChatWorkspaceScale(input: {
  activeView: ViewId;
  chatSidebarCollapsed: boolean;
  hostRef: RefObject<HTMLDivElement | null>;
}): {
  active: boolean;
  style: CSSProperties | undefined;
} {
  const [hostWidth, setHostWidth] = useState(0);

  useEffect(() => {
    if (input.activeView !== 'chat') {
      setHostWidth(0);
      return;
    }
    const host = input.hostRef.current;
    if (host === null) {
      return;
    }
    const syncWidth = () => {
      const nextWidth = host.clientWidth;
      setHostWidth((current) => (current === nextWidth ? current : nextWidth));
    };
    syncWidth();
    const resizeObserver = new ResizeObserver(syncWidth);
    resizeObserver.observe(host);
    return () => {
      resizeObserver.disconnect();
    };
  }, [input.activeView, input.chatSidebarCollapsed, input.hostRef]);

  if (input.activeView !== 'chat') {
    return {
      active: false,
      style: undefined
    };
  }

  const scale = resolveChatWorkspaceScale({
    availableWidth: hostWidth,
    chatSidebarCollapsed: input.chatSidebarCollapsed
  });

  return {
    active: scale.active,
    style: {
      '--chat-workspace-scale': String(scale.scale),
      '--chat-workspace-base-width': `${scale.baseWidth}px`
    } as CSSProperties
  };
}
