import {
  CompositeBackend,
  FilesystemBackend,
  type AnyBackendProtocol,
  type EditResult,
  type FilesystemPermission,
  type FileDownloadResponse,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult
} from 'deepagents';
import { join } from 'node:path';
import type { MemoryKind } from '../../../shared/types';
import type { LangChainChatModelHandle } from '../langchain-model-factory';
import { CapacityService } from '../memory/capacity';
import type { ConsolidatorService } from '../memory/consolidator';
import { SecurityScanService } from '../memory/security-scan';
import { buildWorkspaceHash, type RocPaths } from '../paths';
import type { WorkspaceService } from '../workspace-service';
import { WritableMemoryFilesystemBackend } from './writable-memory-backend';

const WORKSPACE_ROUTE = '/workspace/';
const SKILLS_ROUTE = '/skills/';
const MEMORY_ROUTE = '/memory/';
const READ_ONLY_SKILLS_ERROR = 'Roc 已将 /skills/ 挂载为只读能力目录。';
const SKILL_ACCESS_DENIED_ERROR = 'Roc 当前回合未启用这个 skill。';
const UNKNOWN_ROUTE_ERROR = 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。';

export type RocCompositeBackend = {
  readonly routePrefixes: string[];
} & AnyBackendProtocol;

export function createRocFilesystemPermissions(): FilesystemPermission[] {
  return [
    { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
    { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
  ];
}

class RocRouteRejectingFilesystemBackend {
  readonly id = 'roc-route-rejecting-filesystem';

  ls(_path: string): Promise<LsResult> {
    return Promise.resolve({ files: [] });
  }

  read(_filePath: string, _offset?: number, _limit?: number): Promise<ReadResult> {
    return Promise.resolve({ error: UNKNOWN_ROUTE_ERROR });
  }

  readRaw(_filePath: string): Promise<ReadRawResult> {
    return Promise.resolve({ error: UNKNOWN_ROUTE_ERROR });
  }

  grep(_pattern: string, _path?: string | null, _glob?: string | null): Promise<GrepResult> {
    return Promise.resolve({ matches: [] });
  }

  glob(_pattern: string, _path?: string): Promise<GlobResult> {
    return Promise.resolve({ files: [] });
  }

  write(_filePath: string, _content: string): Promise<import('deepagents').WriteResult> {
    return Promise.resolve({ error: UNKNOWN_ROUTE_ERROR });
  }

  edit(_filePath: string, _oldString: string, _newString: string, _replaceAll?: boolean): Promise<EditResult> {
    return Promise.resolve({ error: UNKNOWN_ROUTE_ERROR });
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

class SelectedSkillsFilesystemBackend {
  private readonly selectedSkillIds: ReadonlySet<string>;

  constructor(
    private readonly delegate: FilesystemBackend,
    selectedSkillIds: readonly string[],
    private readonly writeError: string
  ) {
    this.selectedSkillIds = new Set(selectedSkillIds);
  }

  async ls(path: string): Promise<LsResult> {
    if (path === '/') {
      const result = await this.delegate.ls(path);
      if (result.error || result.files === undefined) {
        return result;
      }
      return {
        files: result.files.filter((entry) => {
          const skillId = this.extractSkillId(entry.path);
          return skillId !== null && this.selectedSkillIds.has(skillId);
        })
      };
    }
    if (!this.isAllowedSkillPath(path)) {
      return { error: SKILL_ACCESS_DENIED_ERROR };
    }
    return this.delegate.ls(path);
  }

  async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    if (!this.isAllowedSkillPath(filePath)) {
      return { error: SKILL_ACCESS_DENIED_ERROR };
    }
    return this.delegate.read(filePath, offset, limit);
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    if (!this.isAllowedSkillPath(filePath)) {
      return { error: SKILL_ACCESS_DENIED_ERROR };
    }
    return this.delegate.readRaw(filePath);
  }

  async grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    const targetPath = path ?? '/';
    if (targetPath === '/') {
      const result = await this.delegate.grep(pattern, targetPath, glob);
      if (result.error || result.matches === undefined) {
        return result;
      }
      return {
        matches: result.matches.filter((entry) => {
          const skillId = this.extractSkillId(entry.path);
          return skillId !== null && this.selectedSkillIds.has(skillId);
        })
      };
    }
    if (!this.isAllowedSkillPath(targetPath)) {
      return { error: SKILL_ACCESS_DENIED_ERROR };
    }
    return this.delegate.grep(pattern, targetPath, glob);
  }

  async glob(pattern: string, path?: string): Promise<GlobResult> {
    const targetPath = path ?? '/';
    if (targetPath === '/') {
      const result = await this.delegate.glob(pattern, targetPath);
      if (result.error || result.files === undefined) {
        return result;
      }
      return {
        files: result.files.filter((entry) => {
          const skillId = this.extractSkillId(entry.path);
          return skillId !== null && this.selectedSkillIds.has(skillId);
        })
      };
    }
    if (!this.isAllowedSkillPath(targetPath)) {
      return { error: SKILL_ACCESS_DENIED_ERROR };
    }
    return this.delegate.glob(pattern, targetPath);
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
        error: this.isAllowedSkillPath(path) ? 'permission_denied' : 'permission_denied'
      }))
    );
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const allowedPaths: string[] = [];
    const deniedResults: FileDownloadResponse[] = [];
    for (const path of paths) {
      if (!this.isAllowedSkillPath(path)) {
        deniedResults.push({
          path,
          content: null,
          error: 'permission_denied'
        });
        continue;
      }
      allowedPaths.push(path);
    }
    const allowedResults = allowedPaths.length === 0 ? [] : await this.delegate.downloadFiles(allowedPaths);
    return [...allowedResults, ...deniedResults];
  }

  private extractSkillId(path: string): string | null {
    if (!path.startsWith('/')) {
      return null;
    }
    const remainder = path.slice(1);
    const [skillId] = remainder.split('/');
    return skillId === undefined || skillId.length === 0 ? null : skillId;
  }

  private isAllowedSkillPath(path: string): boolean {
    const skillId = this.extractSkillId(path);
    return skillId !== null && this.selectedSkillIds.has(skillId);
  }
}

class RocNonExecutingCompositeBackend {
  constructor(private readonly delegate: CompositeBackend) {}

  get routePrefixes(): string[] {
    return this.delegate.routePrefixes;
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

  grep(pattern: string, path?: string, glob?: string | null): Promise<GrepResult> {
    return this.delegate.grep(pattern, path, glob);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    return this.delegate.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<import('deepagents').WriteResult> {
    return this.delegate.write(filePath, content);
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    return this.delegate.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.delegate.uploadFiles(files);
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.delegate.downloadFiles(paths);
  }
}

function createRouteBackends(input: {
  workspaceService: WorkspaceService;
  paths: RocPaths;
  securityScan: SecurityScanService;
  capacity: CapacityService;
  consolidatorService: ConsolidatorService;
  activeModelHandle: LangChainChatModelHandle;
  selectedSkillIds?: readonly string[];
}): {
  backend: RocCompositeBackend;
  memoryRoute: string;
} {
  const routeRejectingBackend = new RocRouteRejectingFilesystemBackend();
  const workspace = input.workspaceService.getCurrentWorkspace();
  const workspaceHash = buildWorkspaceHash(workspace === null ? null : workspace.path);
  const skillsBackendBase = new FilesystemBackend({
    rootDir: input.paths.skillsDir,
    virtualMode: true
  });
  const selectedSkillIds = input.selectedSkillIds ?? [];
  const skillsBackend =
    selectedSkillIds.length === 0
      ? new ReadOnlyFilesystemBackend(skillsBackendBase, READ_ONLY_SKILLS_ERROR)
      : new SelectedSkillsFilesystemBackend(skillsBackendBase, selectedSkillIds, READ_ONLY_SKILLS_ERROR);
  const memoryBackendBase = new FilesystemBackend({
    rootDir: input.paths.memoryDir,
    virtualMode: true
  });
  const routes: Record<string, AnyBackendProtocol> = {
    [SKILLS_ROUTE]: skillsBackend,
    [MEMORY_ROUTE]: new WritableMemoryFilesystemBackend(
      memoryBackendBase,
      workspaceHash,
      input.securityScan,
      input.capacity,
      (resolved, kind) => input.consolidatorService.scheduleForFile(
        join(input.paths.memoryDir, resolved),
        kind,
        input.activeModelHandle
      )
    )
  };

  if (workspace !== null) {
    routes[WORKSPACE_ROUTE] = new FilesystemBackend({
      rootDir: workspace.path,
      virtualMode: true
    });
  }

  const routedBackend = new CompositeBackend(routeRejectingBackend, routes);
  const backend = new RocNonExecutingCompositeBackend(routedBackend);

  return {
    backend,
    memoryRoute: MEMORY_ROUTE
  };
}

export function createBackend(input: {
  workspaceService: WorkspaceService;
  paths: RocPaths;
  securityScan: SecurityScanService;
  capacity: CapacityService;
  consolidatorService: ConsolidatorService;
  activeModelHandle: LangChainChatModelHandle;
  selectedSkillIds?: readonly string[];
}): {
  backend: RocCompositeBackend;
  memoryRoute: string;
} {
  return createRouteBackends(input);
}
