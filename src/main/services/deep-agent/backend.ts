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

const WORKSPACE_ROUTE = '/workspace';
const WORKSPACE_ROUTE_PREFIX = '/workspace/';
const SKILLS_ROUTE = '/skills';
const SKILLS_ROUTE_PREFIX = '/skills/';

function isWorkspaceRoute(path: string): boolean {
  return path === WORKSPACE_ROUTE || path.startsWith(WORKSPACE_ROUTE_PREFIX);
}

function isSkillsRoute(path: string): boolean {
  return path === SKILLS_ROUTE || path.startsWith(SKILLS_ROUTE_PREFIX);
}

function isCanonicalRoute(path: string): boolean {
  return isWorkspaceRoute(path) || isSkillsRoute(path);
}

function invalidRouteError(path: string): string {
  return `Roc filesystem paths must stay under /workspace/ or /skills/. Received: ${path}`;
}

function skillsWriteDeniedError(path: string): string {
  return `Roc skill files are read-only at runtime. Write operations are not allowed for: ${path}`;
}

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
    if (!isCanonicalRoute(path)) {
      return Promise.resolve({
        error: invalidRouteError(path)
      });
    }
    return this.fileBackend.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    if (!isCanonicalRoute(filePath)) {
      return Promise.resolve({
        error: invalidRouteError(filePath)
      });
    }
    return this.fileBackend.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    if (!isCanonicalRoute(filePath)) {
      return Promise.resolve({
        error: invalidRouteError(filePath)
      });
    }
    return this.fileBackend.readRaw(filePath);
  }

  grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    if (path !== null && path !== undefined && !isCanonicalRoute(path)) {
      return Promise.resolve({
        error: invalidRouteError(path)
      });
    }
    return this.fileBackend.grep(pattern, path ?? undefined, glob ?? undefined);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    if (path !== undefined && !isCanonicalRoute(path)) {
      return Promise.resolve({
        error: invalidRouteError(path)
      });
    }
    return this.fileBackend.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<WriteResult> {
    if (!isCanonicalRoute(filePath)) {
      return Promise.resolve({
        error: invalidRouteError(filePath)
      });
    }
    if (!isWorkspaceRoute(filePath)) {
      return Promise.resolve({
        error: skillsWriteDeniedError(filePath)
      });
    }
    return this.fileBackend.write(filePath, content);
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    if (!isCanonicalRoute(filePath)) {
      return Promise.resolve({
        error: invalidRouteError(filePath)
      });
    }
    if (!isWorkspaceRoute(filePath)) {
      return Promise.resolve({
        error: skillsWriteDeniedError(filePath)
      });
    }
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
