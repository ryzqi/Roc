type SendableWebContents = {
  isDestroyed: () => boolean;
  send: (channel: string, payload: unknown) => void;
};

type SendableWindow = {
  isDestroyed: () => boolean;
  webContents: SendableWebContents;
};

type BroadcastOptions = {
  include: (window: SendableWindow, index: number) => boolean;
};

export function sendToWindow(window: SendableWindow | null, channel: string, payload: unknown): boolean {
  if (window === null || window.isDestroyed()) {
    return false;
  }
  const contents = window.webContents as SendableWebContents;
  if (contents.isDestroyed()) {
    return false;
  }
  contents.send(channel, payload);
  return true;
}

export function broadcastToWindows(
  windows: readonly (SendableWindow | null)[],
  channel: string,
  payload: unknown,
  options?: BroadcastOptions
): void {
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (window !== null && options !== undefined && !options.include(window, index)) {
      continue;
    }
    sendToWindow(window, channel, payload);
  }
}
