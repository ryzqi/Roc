import { randomUUID } from 'node:crypto';
import { existsSync, realpath, statSync } from 'node:fs';
import { promisify } from 'node:util';

const realpathNative = promisify(realpath.native);
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Workspace } from '../../shared/types';
import type { RocSettings } from './config-service';
import { RocDomainError } from './errors';

export type WorkspaceConfigService = {
  getSettings(): RocSettings;
  saveSettings(settings: RocSettings): void;
};

export class WorkspaceService {
  private currentWorkspace: Workspace | null = null;

  constructor(private readonly configService: WorkspaceConfigService) {}

  selectWorkspace(path: string): Workspace {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath)) {
      throw new RocDomainError({
        code: 'workspace_path_missing',
        message: '工作区路径不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个存在的目录作为工作区。'
      });
    }

    const stat = statSync(resolvedPath);
    if (!stat.isDirectory()) {
      throw new RocDomainError({
        code: 'workspace_path_not_directory',
        message: '工作区路径必须是目录。',
        category: 'validation',
        retryable: false,
        userAction: '请选择一个目录作为工作区。'
      });
    }

    this.currentWorkspace = this.createWorkspace(resolvedPath);
    return this.currentWorkspace;
  }

  getCurrentWorkspace(): Workspace | null {
    return this.currentWorkspace;
  }

  requireWorkspace(): Workspace {
    const workspace = this.getCurrentWorkspace();
    if (workspace === null) {
      throw new RocDomainError({
        code: 'workspace_not_selected',
        message: '尚未选择工作区。',
        category: 'validation',
        retryable: false,
        userAction: '请先选择一个工作区。'
      });
    }
    if (!existsSync(workspace.path)) {
      throw new RocDomainError({
        code: 'workspace_path_missing',
        message: '工作区路径不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个存在的目录作为工作区。'
      });
    }
    return workspace;
  }

  resolveInsideWorkspace(relativePath: string): string {
    const workspace = this.requireWorkspace();
    const target = resolve(workspace.path, relativePath);
    if (!this.isInsideWorkspace(target, workspace.path)) {
      throw new RocDomainError({
        code: 'workspace_path_outside',
        message: '目标路径不在当前工作区内。',
        category: 'permission',
        retryable: false,
        userAction: '请把操作限制在当前工作区内，或通过确认流程授权越界操作。'
      });
    }
    return target;
  }

  isPathInsideCurrentWorkspace(path: string): boolean {
    const workspace = this.requireWorkspace();
    return this.isInsideWorkspace(resolve(path), workspace.path);
  }

  async assertRealPathInsideWorkspace(path: string): Promise<void> {
    const workspace = this.requireWorkspace();
    const realWorkspace = await realpathNative(workspace.path);
    const realTarget = await realpathNative(path);
    if (!this.isInsideWorkspace(realTarget, realWorkspace)) {
      throw new RocDomainError({
        code: 'workspace_real_path_outside',
        message: '目标文件的真实路径不在当前工作区内。',
        category: 'permission',
        retryable: false,
        userAction: '请改为预览工作区内真实存在的文件。'
      });
    }
  }

  private createWorkspace(path: string): Workspace {
    return {
      id: `workspace_${randomUUID()}`,
      path,
      displayName: basename(path),
      lastOpenedAt: new Date().toISOString(),
      trustState: 'trusted'
    };
  }

  private isInsideWorkspace(path: string, workspaceRoot: string): boolean {
    const relativePath = relative(resolve(workspaceRoot), resolve(path));
    return relativePath === '' || (
      relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
    );
  }
}
