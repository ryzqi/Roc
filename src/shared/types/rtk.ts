export type RtkBypassReason =
  | 'rtk_binary_missing'
  | 'user_terminal_raw_output'
  | 'command_not_supported'
  | 'command_requires_confirmation';

export type RtkStatus = {
  enabledForAgentCommands: boolean;
  binaryPath: string;
  configPath: string;
  teeDir: string;
  resourceState: 'ready' | 'missing';
  bypassReason?: RtkBypassReason;
};

export type ShellCommandSource = 'agent' | 'terminal';
export type ShellCommandRisk = 'low' | 'medium' | 'high';

export type ShellExecutionRequest = {
  command: string;
  cwd?: string;
  source: ShellCommandSource;
  threadId?: string;
  runId?: string;
};

export type ShellExecutionDecision =
  | {
      status: 'allowed';
      riskLevel: 'low';
      normalizedCommand: string;
    }
  | {
      status: 'requires_confirmation';
      reason: 'workspace_outside' | 'high_risk_command' | 'unknown_command';
      riskLevel: Exclude<ShellCommandRisk, 'low'>;
      normalizedCommand: string;
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
