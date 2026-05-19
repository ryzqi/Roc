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
const DISALLOWED_SKILL_PATH_ERROR = 'Roc 仅允许本轮已选中的 Skill 路径。';
const READ_ONLY_SKILLS_ERROR = 'Roc 已将 /skills/ 挂载为只读能力目录。';

export type RocCompositeBackend = CompositeBackend &
  SandboxBackendProtocolV2 & {
    readonly routePrefixes: string[];
  };

class RocSkillsBackend {
  constructor(
    private readonly delegate: FilesystemBackend,
    selectedSkillIds?: readonly string[]
  ) {
    this.selectedSkillIds = selectedSkillIds === undefined ? null : new Set(selectedSkillIds);
  }

  private readonly selectedSkillIds: ReadonlySet<string> | null;

  ls(path: string): Promise<LsResult> {
    const normalizedPath = this.normalizeDelegatePath(path);
    if (normalizedPath === null) {
      return Promise.resolve({ error: DISALLOWED_SKILL_PATH_ERROR });
    }
    return this.delegate.ls(normalizedPath).then((result) => {
      if (result.error !== undefined || result.files === undefined || !this.isSkillsRoot(path)) {
        return result;
      }
      return {
        ...result,
        files: result.files.filter((entry) => this.isAllowedSkillPath(entry.path))
      };
    });
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    const normalizedPath = this.normalizeDelegatePath(filePath);
    if (normalizedPath === null) {
      return Promise.resolve({ error: DISALLOWED_SKILL_PATH_ERROR });
    }
    return this.delegate.read(normalizedPath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    const normalizedPath = this.normalizeDelegatePath(filePath);
    if (normalizedPath === null) {
      return Promise.resolve({ error: DISALLOWED_SKILL_PATH_ERROR });
    }
    return this.delegate.readRaw(normalizedPath);
  }

  grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    const normalizedPath = this.normalizeOptionalDelegatePath(path);
    if (normalizedPath === null) {
      return Promise.resolve({ error: DISALLOWED_SKILL_PATH_ERROR });
    }
    return this.delegate.grep(pattern, normalizedPath, glob).then((result) => {
      if (!this.shouldFilterRootResults(path) || result.error !== undefined || result.matches === undefined) {
        return result;
      }
      return {
        ...result,
        matches: result.matches.filter((entry) => this.isAllowedSkillPath(entry.path))
      };
    });
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    const normalizedPath = this.normalizeOptionalDelegatePath(path);
    if (normalizedPath === null) {
      return Promise.resolve({ error: DISALLOWED_SKILL_PATH_ERROR });
    }
    return this.delegate.glob(pattern, normalizedPath).then((result) => {
      if (!this.shouldFilterRootResults(path) || result.error !== undefined || result.files === undefined) {
        return result;
      }
      return {
        ...result,
        files: result.files.filter((entry) => this.isAllowedSkillPath(entry.path))
      };
    });
  }

  write(filePath: string, content: string): Promise<import('deepagents').WriteResult> {
    const normalizedPath = this.normalizeDelegatePath(filePath);
    if (normalizedPath === null) {
      return Promise.resolve({ error: DISALLOWED_SKILL_PATH_ERROR });
    }
    return Promise.resolve({ error: READ_ONLY_SKILLS_ERROR });
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    const normalizedPath = this.normalizeDelegatePath(filePath);
    if (normalizedPath === null) {
      return Promise.resolve({ error: DISALLOWED_SKILL_PATH_ERROR });
    }
    return Promise.resolve({ error: READ_ONLY_SKILLS_ERROR });
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(
      files.map(([path]) => ({
        path,
        error: this.normalizeDelegatePath(path) === null ? 'invalid_path' : 'permission_denied'
      }))
    );
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const acceptedPaths: string[] = [];
    const rejectedPaths = new Set<string>();

    for (const path of paths) {
      const normalizedPath = this.normalizeDelegatePath(path);
      if (normalizedPath === null) {
        rejectedPaths.add(path);
        continue;
      }
      acceptedPaths.push(normalizedPath);
    }

    if (acceptedPaths.length === 0) {
      return Promise.resolve(paths.map((path) => ({ path, content: null, error: 'invalid_path' })));
    }

    return this.delegate.downloadFiles(acceptedPaths).then((responses) => {
      const acceptedByNormalizedPath = new Map(responses.map((response) => [response.path, response]));
      return paths.map((path) => {
        if (rejectedPaths.has(path)) {
          return { path, content: null, error: 'invalid_path' };
        }
        const normalizedPath = this.normalizeDelegatePath(path);
        const response = normalizedPath === null ? undefined : acceptedByNormalizedPath.get(normalizedPath);
        return response ?? { path, content: null, error: 'invalid_path' };
      });
    });
  }

  private normalizeOptionalDelegatePath(path: string | null | undefined): string | null {
    if (path === undefined || path === null) {
      return '/';
    }
    return this.normalizeDelegatePath(path);
  }

  private normalizeDelegatePath(path: string): string | null {
    const normalized = path.replaceAll('\\', '/');
    if (this.isSkillsRoot(normalized)) {
      return '/';
    }

    const withoutPrefix = normalized.startsWith(SKILLS_ROUTE)
      ? normalized.slice(SKILLS_ROUTE.length - 1)
      : normalized;
    const candidate = withoutPrefix.startsWith('/') ? withoutPrefix : `/${withoutPrefix}`;
    return candidate;
  }

  private isSkillsRoot(path: string): boolean {
    const normalized = path.replaceAll('\\', '/');
    return normalized === '/' || normalized === SKILLS_ROUTE || normalized === '/skills';
  }

  private shouldFilterRootResults(path: string | null | undefined): boolean {
    if (path === undefined || path === null || path.length === 0) {
      return true;
    }
    return this.isSkillsRoot(path);
  }

  private isAllowedSkillPath(path: string): boolean {
    if (this.selectedSkillIds === null) {
      return true;
    }
    const normalized = path.replaceAll('\\', '/');
    const withoutPrefix = normalized.startsWith(SKILLS_ROUTE)
      ? normalized.slice(SKILLS_ROUTE.length)
      : normalized.startsWith('/skills/')
        ? normalized.slice('/skills/'.length)
        : normalized.startsWith('/')
          ? normalized.slice(1)
          : normalized;
    const [skillId] = withoutPrefix.split('/').filter((segment) => segment.length > 0);
    if (skillId === undefined) {
      return false;
    }
    return this.selectedSkillIds.has(skillId);
  }
}

function createRouteBackends(input: {
  workspaceService: WorkspaceService;
  paths: RocPaths;
  shellExecutionService: AgentExecuteAdapter;
  store: BaseStore;
  selectedSkillIds?: readonly string[];
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
  const routes: Record<string, AnyBackendProtocol> = {
    [SKILLS_ROUTE]: new RocSkillsBackend(skillsBackendBase, input.selectedSkillIds),
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
  selectedSkillIds?: readonly string[];
}): {
  backend: RocCompositeBackend;
  memoryRoute: string;
} {
  return createRouteBackends(input);
}
