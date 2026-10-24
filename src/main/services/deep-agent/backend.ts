import {
  CompositeBackend,
  FilesystemBackend,
  StoreBackend,
  type AnyBackendProtocol,
  type EditResult,
  type FileDownloadResponse,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult
} from 'deepagents';
import type { RunCapabilityManifestSkillV1 } from '../../../shared/types';
import { SelectedSkillsFilesystemBackend } from './skill-backend';
import type { BaseStore } from '@langchain/langgraph';
import { CapacityService } from '../memory/capacity';
import { SecurityScanService } from '../memory/security-scan';
import { listMemorySlots } from '../memory/store-slots';
import { buildWorkspaceHash, type RocPaths } from '../paths';
import type { WorkspaceService } from '../workspace-service';
import {
  ROC_FILE_TOOL_ROUTE_ERROR,
  validateRocFileToolPath
} from './filesystem-tool-contract';
import { RipgrepFilesystemBackend } from './ripgrep-filesystem-backend';
import { RocStoreMemoryBackend } from './store-memory-backend';
import { RipgrepService } from '../ripgrep-service';

const WORKSPACE_ROUTE = '/workspace/';
const SKILLS_ROUTE = '/skills/';
const MEMORY_GLOBAL_ROUTE = '/memory/global/';
const MEMORY_WORKSPACE_ROUTE = '/memory/workspaces/current/';
const WORKSPACE_MEMORY_REQUIRED_ERROR = 'No workspace selected; select a workspace before writing workspace-scoped memory.';

export type RocCompositeBackend = {
  readonly routePrefixes: string[];
} & AnyBackendProtocol;

class RocRouteRejectingFilesystemBackend {
  readonly id = 'roc-route-rejecting-filesystem';

  ls(_path: string): Promise<LsResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  read(_filePath: string, _offset?: number, _limit?: number): Promise<ReadResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  readRaw(_filePath: string): Promise<ReadRawResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  grep(
    _pattern: string,
    _path?: string | null,
    _glob?: string | null,
    _maxCount?: number | null
  ): Promise<GrepResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  glob(_pattern: string, _path?: string): Promise<GlobResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  write(_filePath: string, _content: string): Promise<import('deepagents').WriteResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  edit(_filePath: string, _oldString: string, _newString: string, _replaceAll?: boolean): Promise<EditResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
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
    return Promise.resolve(
      paths.map((path) => ({
        path,
        content: null,
        error: 'permission_denied'
      }))
    );
  }
}

class WorkspaceMemoryRequiredBackend {
  readonly id = 'roc-workspace-memory-required';

  ls(_path: string): Promise<LsResult> {
    return Promise.resolve({ error: WORKSPACE_MEMORY_REQUIRED_ERROR });
  }

  read(_filePath: string, _offset?: number, _limit?: number): Promise<ReadResult> {
    return Promise.resolve({ error: WORKSPACE_MEMORY_REQUIRED_ERROR });
  }

  readRaw(_filePath: string): Promise<ReadRawResult> {
    return Promise.resolve({ error: WORKSPACE_MEMORY_REQUIRED_ERROR });
  }

  grep(
    _pattern: string,
    _path?: string | null,
    _glob?: string | null,
    _maxCount?: number | null
  ): Promise<GrepResult> {
    return Promise.resolve({ error: WORKSPACE_MEMORY_REQUIRED_ERROR });
  }

  glob(_pattern: string, _path?: string): Promise<GlobResult> {
    return Promise.resolve({ error: WORKSPACE_MEMORY_REQUIRED_ERROR });
  }

  write(_filePath: string, _content: string): Promise<import('deepagents').WriteResult> {
    return Promise.resolve({ error: WORKSPACE_MEMORY_REQUIRED_ERROR });
  }

  edit(_filePath: string, _oldString: string, _newString: string, _replaceAll?: boolean): Promise<EditResult> {
    return Promise.resolve({ error: WORKSPACE_MEMORY_REQUIRED_ERROR });
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(files.map(([path]) => ({ path, error: 'permission_denied' })));
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return Promise.resolve(paths.map((path) => ({ path, content: null, error: 'permission_denied' })));
  }
}

class RocNonExecutingCompositeBackend {
  constructor(private readonly delegate: CompositeBackend) {}

  get routePrefixes(): string[] {
    return this.delegate.routePrefixes;
  }

  ls(path: string): Promise<LsResult> {
    const validation = validateRocFileToolPath(path);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    const validation = validateRocFileToolPath(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    const validation = validateRocFileToolPath(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.readRaw(filePath);
  }

  grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
    maxCount?: number | null
  ): Promise<GrepResult> {
    if (typeof path !== 'string') {
      return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
    }
    const validation = validateRocFileToolPath(path);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.grep(pattern, path, glob, maxCount);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    if (typeof path !== 'string') {
      return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
    }
    const validation = validateRocFileToolPath(path);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<import('deepagents').WriteResult> {
    const validation = validateRocFileToolPath(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.write(filePath, content);
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    const validation = validateRocFileToolPath(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const invalid = files.find(([path]) => !validateRocFileToolPath(path).ok);
    if (invalid !== undefined) {
      return Promise.resolve(files.map(([path]) => ({ path, error: 'permission_denied' })));
    }
    return this.delegate.uploadFiles(files);
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const invalid = paths.find((path) => !validateRocFileToolPath(path).ok);
    if (invalid !== undefined) {
      return Promise.resolve(paths.map((path) => ({ path, content: null, error: 'permission_denied' })));
    }
    return this.delegate.downloadFiles(paths);
  }
}

/**
 * 组装文件后端的输入。
 *
 * 它曾经在内部实现和导出的包装函数里各写一遍，新增字段得同步改两处才不漏——而漏掉的那次
 * 不会有编译错误，只会让注入被静默忽略。现在包装函数合并回实现本身，这个类型是唯一入口。
 */
export type RocBackendInput = {
  memoryApplicability: string;
  workspaceService: WorkspaceService;
  paths: RocPaths;
  store: BaseStore;
  securityScan: SecurityScanService;
  capacity: CapacityService;
  selectedSkills: readonly RunCapabilityManifestSkillV1[];
  /** 可注入的 ripgrep 服务；缺省按随包二进制解析。 */
  ripgrep?: RipgrepService;
};

export function createBackend(input: RocBackendInput): {
  backend: RocCompositeBackend;
  memorySources: string[];
} {
  const routeRejectingBackend = new RocRouteRejectingFilesystemBackend();
  const workspace = input.workspaceService.getCurrentWorkspace();
  const workspaceHash = buildWorkspaceHash(workspace === null ? null : workspace.path);
  const skillsBackendBase = new FilesystemBackend({
    rootDir: input.paths.skillsDir,
    virtualMode: true
  });
  const skillsBackend = new SelectedSkillsFilesystemBackend(skillsBackendBase, input.paths.skillsDir, input.selectedSkills);
  const slots = listMemorySlots(workspaceHash);
  const globalSlots = slots.filter((slot) => slot.scope === 'global');
  const workspaceSlots = slots.filter((slot) => slot.scope === 'workspace');
  const globalKindByKey = new Map(globalSlots.map((slot) => [slot.storeKey, slot.kind]));
  const workspaceKindByKey = new Map(workspaceSlots.map((slot) => [slot.storeKey, slot.kind]));
  const routes: Record<string, AnyBackendProtocol> = {
    [SKILLS_ROUTE]: skillsBackend,
    [MEMORY_GLOBAL_ROUTE]: new RocStoreMemoryBackend(
      new StoreBackend({ store: input.store, namespace: ['roc', 'memory', 'global'] }),
      new Set(globalSlots.map((slot) => slot.storeKey)),
      input.securityScan,
      input.capacity,
      globalKindByKey,
      input.memoryApplicability
    )
  };

  routes[MEMORY_WORKSPACE_ROUTE] =
    workspaceHash === null
      ? new WorkspaceMemoryRequiredBackend()
      : new RocStoreMemoryBackend(
          new StoreBackend({ store: input.store, namespace: ['roc', 'memory', 'workspaces', workspaceHash] }),
          new Set(workspaceSlots.map((slot) => slot.storeKey)),
          input.securityScan,
          input.capacity,
          workspaceKindByKey,
          input.memoryApplicability
        );

  if (workspace !== null) {
    // 工作区路由的 grep 走 Roc 自带的 ripgrep（`RipgrepFilesystemBackend` 里有取舍说明）；
    // 其余路由（skills / memory）文件量小，保持上游实现，不再引入第二个差异点。
    routes[WORKSPACE_ROUTE] = new RipgrepFilesystemBackend(input.ripgrep ?? new RipgrepService(), {
      rootDir: workspace.path,
      virtualMode: true
    });
  }

  const routedBackend = new CompositeBackend(routeRejectingBackend, routes);
  const backend = new RocNonExecutingCompositeBackend(routedBackend);

  return {
    backend,
    memorySources: slots.map((slot) => slot.virtualPath)
  };
}
