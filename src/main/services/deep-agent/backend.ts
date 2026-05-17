import {
  CompositeBackend,
  FilesystemBackend,
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

export type RocCompositeBackend = CompositeBackend &
  SandboxBackendProtocolV2 & {
    readonly routePrefixes: string[];
  };

class RocExecuteBackend implements SandboxBackendProtocolV2 {
  readonly id = 'roc-execute-backend';
  readonly routePrefixes: string[] = [];

  constructor(private readonly shellExecutionService: AgentExecuteAdapter) {
  }

  ls(path: string): Promise<LsResult> {
    if (path === '/') {
      return Promise.resolve({ files: [] });
    }
    return Promise.resolve({ error: 'Roc filesystem paths must stay under /workspace/, /skills/, or /memory/.' });
  }

  read(_filePath: string, _offset?: number, _limit?: number): Promise<ReadResult> {
    return Promise.resolve({ error: 'Roc filesystem paths must stay under /workspace/, /skills/, or /memory/.' });
  }

  readRaw(_filePath: string): Promise<ReadRawResult> {
    return Promise.resolve({ error: 'Roc filesystem paths must stay under /workspace/, /skills/, or /memory/.' });
  }

  grep(_pattern: string, path?: string, _glob?: string | null): Promise<GrepResult> {
    if (path === undefined || path === '/') {
      return Promise.resolve({ matches: [] });
    }
    return Promise.resolve({ error: 'Roc filesystem paths must stay under /workspace/, /skills/, or /memory/.' });
  }

  glob(_pattern: string, path?: string): Promise<GlobResult> {
    if (path === undefined || path === '/') {
      return Promise.resolve({ files: [] });
    }
    return Promise.resolve({ error: 'Roc filesystem paths must stay under /workspace/, /skills/, or /memory/.' });
  }

  write(_filePath: string, _content: string): Promise<import('deepagents').WriteResult> {
    return Promise.resolve({ error: 'Roc filesystem paths must stay under /workspace/, /skills/, or /memory/.' });
  }

  edit(_filePath: string, _oldString: string, _newString: string, _replaceAll?: boolean): Promise<EditResult> {
    return Promise.resolve({ error: 'Roc filesystem paths must stay under /workspace/, /skills/, or /memory/.' });
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(
      files.map(([path]) => ({
        path,
        error: 'invalid_path'
      }))
    );
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return Promise.resolve(paths.map((path) => ({ path, content: null, error: 'file_not_found' })));
  }

  execute(command: string): Promise<ExecuteResponse> {
    return Promise.resolve(this.shellExecutionService.executeAgentCommand({ command }));
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
  const workspace = input.workspaceService.getCurrentWorkspace();
  const routes: Record<string, AnyBackendProtocol> = {
    [SKILLS_ROUTE]: new FilesystemBackend({
      rootDir: input.paths.skillsDir,
      virtualMode: true
    }),
    [MEMORY_ROUTE]: new StoreBackend({
      store: input.store,
      namespace: ['roc', 'memory', 'filesystem']
    })
  };

  if (workspace !== null) {
    routes[WORKSPACE_ROUTE] = new FilesystemBackend({
      rootDir: workspace.path,
      virtualMode: true
    });
  }

  return {
    backend: new CompositeBackend(new RocExecuteBackend(input.shellExecutionService), routes) as RocCompositeBackend,
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
