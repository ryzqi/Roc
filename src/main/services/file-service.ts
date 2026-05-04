import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type {
  FilePreviewRequest,
  FilePreviewResult,
  FileSearchRequest,
  FileSearchResult,
  FileTreeRequest,
  FileTreeResult,
  FileWriteResult,
  FileWriteTextRequest,
  RecoveryPoint
} from '../../shared/types';
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';
import type { WorkspaceService } from './workspace-service';

const defaultPreviewBytes = 64 * 1024;
const defaultListLimit = 200;
const defaultSearchLimit = 100;
const ignoredDirectoryNames = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  'coverage',
  '.cache',
  '.tmp',
  '.runtime',
  '.artifacts'
]);

export class FileService {
  constructor(
    private readonly paths: RocPaths,
    private readonly database: DatabaseService,
    private readonly workspaceService: WorkspaceService
  ) {}

  listTree(request: FileTreeRequest): FileTreeResult {
    const workspace = this.workspaceService.requireWorkspace();
    const relativePath = this.normalizeRelativePath(request.relativePath);
    const target = this.workspaceService.resolveInsideWorkspace(relativePath);
    const stat = statSync(target);
    if (!stat.isDirectory()) {
      throw new RocDomainError({
        code: 'file_tree_target_not_directory',
        message: '文件树目标必须是目录。',
        category: 'validation',
        retryable: false,
        userAction: '请选择一个目录。'
      });
    }

    const limit = this.positiveLimit(request.limit, defaultListLimit);
    const children = readdirSync(target, { withFileTypes: true })
      .filter((entry) => !ignoredDirectoryNames.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    const visibleChildren = children.slice(0, limit);

    return {
      workspacePath: workspace.path,
      relativePath,
      entries: visibleChildren.map((entry) => {
        const absolutePath = join(target, entry.name);
        const entryStat = statSync(absolutePath);
        return {
          name: entry.name,
          relativePath: this.toWorkspaceRelativePath(workspace.path, absolutePath),
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entryStat.size,
          updatedAt: entryStat.mtime.toISOString()
        };
      }),
      truncated: children.length > visibleChildren.length
    };
  }

  search(request: FileSearchRequest): FileSearchResult {
    const query = request.query.trim();
    if (query.length === 0) {
      throw new RocDomainError({
        code: 'file_search_query_empty',
        message: '文件搜索 query 不能为空。',
        category: 'validation',
        retryable: true,
        userAction: '请输入要搜索的关键词。'
      });
    }

    const workspace = this.workspaceService.requireWorkspace();
    const maxResults = this.positiveLimit(request.maxResults, defaultSearchLimit);
    const matches: FileSearchResult['matches'] = [];
    this.visitFiles(workspace.path, (absolutePath) => {
      if (matches.length >= maxResults) {
        return true;
      }
      const buffer = this.readSearchBuffer(absolutePath);
      if (buffer === null) {
        return false;
      }
      if (this.isBinaryBuffer(buffer)) {
        return false;
      }
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const column = line.indexOf(query);
        if (column < 0) {
          continue;
        }
        matches.push({
          relativePath: this.toWorkspaceRelativePath(workspace.path, absolutePath),
          line: index + 1,
          column: column + 1,
          preview: line.trim()
        });
        if (matches.length >= maxResults) {
          return true;
        }
      }
      return false;
    });

    return {
      query,
      matches,
      truncated: matches.length >= maxResults
    };
  }

  readPreview(request: FilePreviewRequest): FilePreviewResult {
    const relativePath = this.normalizeRelativePath(request.relativePath);
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      throw new RocDomainError({
        code: 'file_preview_target_not_file',
        message: '文件预览目标必须是文件。',
        category: 'validation',
        retryable: false,
        userAction: '请选择一个文件。'
      });
    }

    const maxBytes = this.positiveLimit(request.maxBytes, defaultPreviewBytes);
    const buffer = readFileSync(absolutePath);
    if (this.isBinaryBuffer(buffer)) {
      return {
        relativePath,
        kind: 'binary',
        content: '',
        truncated: false,
        sizeBytes: buffer.byteLength
      };
    }

    return {
      relativePath,
      kind: 'text',
      content: buffer.subarray(0, maxBytes).toString('utf8'),
      truncated: buffer.byteLength > maxBytes,
      sizeBytes: buffer.byteLength
    };
  }

  writeTextFile(request: FileWriteTextRequest): FileWriteResult {
    const relativePath = this.normalizeRelativePath(request.relativePath);
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    const recoveryPoint = this.createRecoveryPoint(relativePath, absolutePath, request.source);

    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, request.content, 'utf8');

    return {
      relativePath,
      recoveryPoint,
      bytesWritten: Buffer.byteLength(request.content, 'utf8')
    };
  }

  private createRecoveryPoint(relativePath: string, absolutePath: string, source: string): RecoveryPoint {
    const createdAt = new Date().toISOString();
    const id = `recovery_${randomUUID()}`;
    const snapshotDir = join(this.paths.tasksDir, 'recovery', id);
    mkdirSync(snapshotDir, { recursive: true });
    const originalContent = existsSync(absolutePath) ? readFileSync(absolutePath) : Buffer.from('');
    const snapshotPath = join(snapshotDir, 'original');
    writeFileSync(snapshotPath, originalContent);
    const contentSha256 = createHash('sha256').update(originalContent).digest('hex');
    const recoveryPoint: RecoveryPoint = {
      id,
      relativePath,
      snapshotPath,
      contentSha256,
      source,
      createdAt,
      restored: false
    };

    this.database.db
      .prepare(
        `INSERT INTO recovery_points
         (id, relative_path, snapshot_path, content_sha256, source, created_at, restored)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, relativePath, snapshotPath, contentSha256, source, createdAt, 0);

    return recoveryPoint;
  }

  private visitFiles(root: string, visit: (absolutePath: string) => boolean): boolean {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (this.isRecoverableFileSystemError(error)) {
        return false;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) {
        continue;
      }

      const absolutePath = join(root, entry.name);
      if (entry.isDirectory()) {
        if (this.visitFiles(absolutePath, visit)) {
          return true;
        }
        continue;
      }
      if (entry.isFile()) {
        if (visit(absolutePath)) {
          return true;
        }
      }
    }
    return false;
  }

  private readSearchBuffer(absolutePath: string): Buffer | null {
    try {
      return readFileSync(absolutePath);
    } catch (error) {
      if (this.isRecoverableFileSystemError(error)) {
        return null;
      }
      throw error;
    }
  }

  private isRecoverableFileSystemError(error: unknown): boolean {
    if (!(error instanceof Error) || !('code' in error)) {
      return false;
    }
    return ['EACCES', 'EBUSY', 'ENOENT', 'ENOTDIR', 'EPERM', 'ELOOP', 'ENAMETOOLONG'].includes(String(error.code));
  }

  private normalizeRelativePath(relativePath: string): string {
    const trimmed = relativePath.trim();
    if (trimmed.length === 0 || trimmed === '.') {
      return '';
    }
    return trimmed.replaceAll('\\', '/');
  }

  private toWorkspaceRelativePath(workspacePath: string, absolutePath: string): string {
    return relative(workspacePath, absolutePath).replaceAll('\\', '/');
  }

  private positiveLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) {
      return fallback;
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new RocDomainError({
        code: 'invalid_limit',
        message: 'limit 必须是正整数。',
        category: 'validation',
        retryable: true,
        userAction: '请提供正整数 limit。'
      });
    }
    return value;
  }

  private isBinaryBuffer(buffer: Buffer): boolean {
    return buffer.subarray(0, 4096).includes(0);
  }
}
