export type RtkBypassReason =
  | 'rtk_binary_missing'
  | 'user_terminal_raw_output'
  | 'command_not_supported';

export type RtkStatus = {
  enabledForAgentCommands: boolean;
  binaryPath: string;
  configPath: string;
  teeDir: string;
  resourceState: 'ready' | 'missing';
  bypassReason?: RtkBypassReason;
};

export type ShellCommandSource = 'agent' | 'terminal';

export type ShellExecutionRequest = {
  command: string;
  cwd?: string;
  source: ShellCommandSource;
  threadId?: string;
  runId?: string;
};

export type ShellExecutionResult = {
  command: string;
  normalizedCommand: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  usedRtk: boolean;
  rtkVersion?: string;
  teePath?: string;
  bypassReason?: RtkBypassReason;
};
