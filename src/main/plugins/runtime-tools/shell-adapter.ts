import type { ShellExecutionResult } from '../../../shared/types';
import type { RtkService } from '../../services/rtk-service';
import { defaultSettings } from '../../services/config/defaults';
import { RocPaths } from '../../services/paths';
import { ShellExecutionService, type ShellTaskEventRecorder } from '../../services/shell-execution-service';
import { WorkspaceService, type WorkspaceConfigService } from '../../services/workspace-service';

export type ShellCommandExecutor = (
  file: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>
) => {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ShellAdapterOptions = {
  rootDir?: string;
  workspacePath?: string;
  rtkService: RtkService;
  commandExecutor?: ShellCommandExecutor;
  taskRecorder?: ShellTaskEventRecorder;
};

export function createShellExecutionService(options: ShellAdapterOptions): ShellExecutionService {
  const paths = new RocPaths(options.rootDir);
  paths.ensureTree();
  const workspaceService = new WorkspaceService(createWorkspaceConfig(options.workspacePath));
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
    extraEnv: Record<string, string> = {}
  ): Promise<Omit<ShellExecutionResult, 'command' | 'normalizedCommand' | 'cwd' | 'durationMs' | 'usedRtk' | 'bypassReason'>> {
    return this.commandExecutor(file, args, cwd, extraEnv);
  }
}

function createWorkspaceConfig(workspacePath: string | undefined): WorkspaceConfigService {
  return {
    getSettings: () => ({
      ...defaultSettings,
      defaultWorkspace: workspacePath === undefined ? null : workspacePath
    }),
    saveSettings: () => {}
  };
}

function createNoopTaskRecorder(): ShellTaskEventRecorder {
  return {
    recordEvent: () => undefined
  };
}
