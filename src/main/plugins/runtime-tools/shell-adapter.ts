import type { ShellExecutionResult } from '../../../shared/types';
import type { RtkService } from '../../services/rtk-service';
import { ShellExecutionService, type ShellTaskEventRecorder } from '../../services/shell-execution-service';
import { WorkspaceService } from '../../services/workspace-service';

export type ShellCommandExecutor = (
  file: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
  signal?: AbortSignal
) => {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ShellAdapterOptions = {
  workspacePath?: string;
  /** A shared binding: when present this adapter reads it instead of creating its own. */
  workspaceService?: WorkspaceService;
  rtkService: RtkService;
  commandExecutor?: ShellCommandExecutor;
  taskRecorder?: ShellTaskEventRecorder;
};

export function createShellExecutionService(options: ShellAdapterOptions): ShellExecutionService {
  const workspaceService = options.workspaceService ?? new WorkspaceService();
  if (options.workspacePath !== undefined) {
    workspaceService.selectWorkspace(options.workspacePath);
  }
  const taskRecorder = options.taskRecorder === undefined ? createNoopTaskRecorder() : options.taskRecorder;
  if (options.commandExecutor !== undefined) {
    return new InjectableShellExecutionService(
      workspaceService,
      options.rtkService,
      taskRecorder,
      options.commandExecutor
    );
  }
  return new ShellExecutionService(workspaceService, options.rtkService, taskRecorder);
}

class InjectableShellExecutionService extends ShellExecutionService {
  constructor(
    workspaceService: WorkspaceService,
    rtkService: RtkService,
    taskRecorder: ShellTaskEventRecorder,
    private readonly commandExecutor: ShellCommandExecutor
  ) {
    super(workspaceService, rtkService, taskRecorder);
  }

  protected override execFile(
    file: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {}
  ): Omit<ShellExecutionResult, 'command' | 'normalizedCommand' | 'cwd' | 'durationMs' | 'usedRtk' | 'bypassReason'> {
    return this.commandExecutor(file, args, cwd, extraEnv);
  }

  protected override async execFileAsync(
    file: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {},
    signal?: AbortSignal
  ): Promise<Omit<ShellExecutionResult, 'command' | 'normalizedCommand' | 'cwd' | 'durationMs' | 'usedRtk' | 'bypassReason'>> {
    return this.commandExecutor(file, args, cwd, extraEnv, signal);
  }
}

function createNoopTaskRecorder(): ShellTaskEventRecorder {
  return {
    recordEvent: () => undefined
  };
}
