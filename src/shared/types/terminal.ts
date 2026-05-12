export type TerminalSessionId = string;
export type TerminalSessionStatus = 'starting' | 'ready' | 'exited' | 'error';

export type TerminalSessionCreateRequest = {
  cwd?: string;
  cols: number;
  rows: number;
};

export type TerminalSessionSnapshot = {
  id: TerminalSessionId;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: TerminalSessionStatus;
  exitCode: number | null;
};

export type TerminalSessionInputRequest = {
  sessionId: TerminalSessionId;
  data: string;
};

export type TerminalSessionResizeRequest = {
  sessionId: TerminalSessionId;
  cols: number;
  rows: number;
};

export type TerminalSessionCloseRequest = {
  sessionId: TerminalSessionId;
};

export type TerminalSessionOutputEvent = {
  sessionId: TerminalSessionId;
  data: string;
};

export type TerminalSessionExitEvent = {
  sessionId: TerminalSessionId;
  exitCode: number | null;
};
