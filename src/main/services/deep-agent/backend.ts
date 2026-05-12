import {
  CompositeBackend,
  FilesystemBackend,
  LocalShellBackend,
  StateBackend,
  type EditResult,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type SandboxBackendProtocolV2,
  type WriteResult
} from 'deepagents';
import type { ShellExecutionResult } from '../../../shared/types';
import type { RocPaths } from '../paths';
import type { WorkspaceService } from '../workspace-service';

type AgentExecuteAdapter = {
  executeAgentCommand(input: { command: string; cwd?: string }): ExecuteResponse & {
    command: string;
    cwd: string;
    usedRtk: boolean;
    bypassReason?: ShellExecutionResult['bypassReason'];
  };
};

class RocAgentBackend implements SandboxBackendProtocolV2 {
  private readonly fileBackend: CompositeBackend;
  private readonly shellBackend: LocalShellBackend;

  constructor(
    workspaceService: WorkspaceService,
    paths: RocPaths,
    private readonly shellExecutionService: AgentExecuteAdapter
  ) {
    const workspace = workspaceService.getCurrentWorkspace();
    const shellRoot = workspace?.path ?? paths.root;
    this.shellBackend = new LocalShellBackend({
      rootDir: shellRoot,
      inheritEnv: true
    });
    this.fileBackend = new CompositeBackend(
      new StateBackend(),
      workspace === null
        ? {
            '/skills/': new FilesystemBackend({
              rootDir: paths.skillsDir,
              virtualMode: true
            })
          }
        : {
            '/workspace/': new FilesystemBackend({
              rootDir: workspace.path,
              virtualMode: true
            }),
            '/skills/': new FilesystemBackend({
              rootDir: paths.skillsDir,
              virtualMode: true
            })
          }
    );
  }

  get id(): string {
    return this.shellBackend.id;
  }

  get routePrefixes(): string[] {
    return this.fileBackend.routePrefixes;
  }

  ls(path: string): Promise<LsResult> {
    return this.fileBackend.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.fileBackend.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    return this.fileBackend.readRaw(filePath);
  }

  grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    return this.fileBackend.grep(pattern, path ?? undefined, glob ?? undefined);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    return this.fileBackend.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<WriteResult> {
    return this.fileBackend.write(filePath, content);
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    return this.fileBackend.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.fileBackend.uploadFiles(files);
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.fileBackend.downloadFiles(paths);
  }

  execute(command: string): Promise<ExecuteResponse> {
    return Promise.resolve(this.shellExecutionService.executeAgentCommand({ command }));
  }
}

export function createBackend(
  workspaceService: WorkspaceService,
  paths: RocPaths,
  shellExecutionService: AgentExecuteAdapter
): SandboxBackendProtocolV2 {
  const workspace = workspaceService.getCurrentWorkspace();
  void workspace;
  return new RocAgentBackend(workspaceService, paths, shellExecutionService);
}
