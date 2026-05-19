import {
  CompositeBackend,
  FilesystemBackend,
  StateBackend,
  StoreBackend,
  type AnyBackendProtocol,
  type EditResult,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type SandboxBackendProtocolV2
} from 'deepagents';
import type { BaseStore } from '@langchain/langgraph';
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

const WORKSPACE_ROUTE = '/workspace/';
const SKILLS_ROUTE = '/skills/';
const MEMORY_ROUTE = '/memory/';
const AGENTS_ROUTE = '/agents/';
const READ_ONLY_SKILLS_ERROR = 'Roc 已将 /skills/ 挂载为只读能力目录。';
const READ_ONLY_AGENTS_ERROR = 'Roc 已将 /agents/ 挂载为只读项目规则目录。';

export type RocCompositeBackend = CompositeBackend &
  SandboxBackendProtocolV2 & {
    readonly routePrefixes: string[];
  };

class ReadOnlyFilesystemBackend {
  constructor(
    private readonly delegate: FilesystemBackend,
    private readonly writeError: string
  ) {
  }

  ls(path: string): Promise<LsResult> {
    return this.delegate.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.delegate.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    return this.delegate.readRaw(filePath);
  }

  grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    return this.delegate.grep(pattern, path ?? undefined, glob);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    return this.delegate.glob(pattern, path);
  }

  write(_filePath: string, _content: string): Promise<import('deepagents').WriteResult> {
    return Promise.resolve({ error: this.writeError });
  }

  edit(_filePath: string, _oldString: string, _newString: string, _replaceAll?: boolean): Promise<EditResult> {
    return Promise.resolve({ error: this.writeError });
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(
      files.map(([path]) => ({
        path,
        error: 'permission_denied'
      }))
    );
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.delegate.downloadFiles(paths);
  }
}

function createRouteBackends(input: {
  workspaceService: WorkspaceService;
  paths: RocPaths;
  shellExecutionService: AgentExecuteAdapter;
  store: BaseStore;
}): {
  backend: RocCompositeBackend;
  memoryRoute: string;
} {
  const stateBackend = new StateBackend({
    state: {
      files: {}
    }
  } as never);
  const workspace = input.workspaceService.getCurrentWorkspace();
  const skillsBackendBase = new FilesystemBackend({
    rootDir: input.paths.skillsDir,
    virtualMode: true
  });
  const agentsBackendBase = new FilesystemBackend({
    rootDir: input.paths.memoryDir,
    virtualMode: true
  });
  const routes: Record<string, AnyBackendProtocol> = {
    [SKILLS_ROUTE]: new ReadOnlyFilesystemBackend(skillsBackendBase, READ_ONLY_SKILLS_ERROR),
    [AGENTS_ROUTE]: new ReadOnlyFilesystemBackend(agentsBackendBase, READ_ONLY_AGENTS_ERROR),
    [MEMORY_ROUTE]: new StoreBackend({
      store: input.store,
      namespace: ['roc', 'memory', 'filesystem'],
      fileFormat: 'v2'
    })
  };

  if (workspace !== null) {
    routes[WORKSPACE_ROUTE] = new FilesystemBackend({
      rootDir: workspace.path,
      virtualMode: true
    });
  }

  const backend = new CompositeBackend(stateBackend, routes) as RocCompositeBackend;
  backend.execute = (command: string) =>
    Promise.resolve(input.shellExecutionService.executeAgentCommand({ command }));

  return {
    backend,
    memoryRoute: MEMORY_ROUTE
  };
}

export function createBackend(input: {
  workspaceService: WorkspaceService;
  paths: RocPaths;
  shellExecutionService: AgentExecuteAdapter;
  store: BaseStore;
}): {
  backend: RocCompositeBackend;
  memoryRoute: string;
} {
  return createRouteBackends(input);
}
