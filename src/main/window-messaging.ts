type SendableWebContents = {
  isDestroyed: () => boolean;
  send: (channel: string, payload: unknown) => void;
};

type SendableWindow = {
  isDestroyed: () => boolean;
  webContents: SendableWebContents;
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
  payload: unknown
): void {
  for (const window of windows) {
    sendToWindow(window, channel, payload);
  }
}
