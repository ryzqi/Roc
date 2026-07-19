export type RtkBypassReason =
  | 'rtk_binary_missing'
  | 'user_terminal_raw_output'
  | 'command_not_supported'
  | 'virtual_workspace_path'
  | 'windows_shell_alias'
  | 'shell_run_not_authorized'
  | 'background_shell_command_not_pre_authorized';

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
  signal?: AbortSignal;
  allowedCommands?: string[];
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
  truncated?: boolean;
  rtkVersion?: string;
  teePath?: string;
  bypassReason?: RtkBypassReason;
};
