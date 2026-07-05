import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import type {
  FileDeleteResult,
  FilePreviewRequest,
  FilePreviewResult,
  FileSearchRequest,
  FileSearchResult,
  FileTreeRequest,
  FileTreeResult,
  FilesWorkbenchPdfPreviewRequest,
  FilesWorkbenchPdfPreviewResult,
  FileWriteResult,
  FileWriteTextRequest,
  RecoveryPoint
} from '../../shared/types';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';
import type { WorkspaceService } from './workspace-service';

const defaultPreviewBytes = 64 * 1024;
const defaultListLimit = 200;
const defaultSearchLimit = 100;
const binaryProbeBytes = 4096;
const defaultSearchMaxVisitedFiles = 2000;
const defaultSearchMaxBytes = 4 * 1024 * 1024;
const imageMediaTypes = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml']
]);
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

export type FileRecoveryPointDatabase = {
  readonly db: DatabaseConnection;
};

export class FileService {
  constructor(
    private readonly paths: RocPaths,
    private readonly database: FileRecoveryPointDatabase,
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
    let truncated = false;
    let visitedFiles = 0;
    let scannedBytes = 0;
    this.visitFiles(workspace.path, (absolutePath) => {
      if (matches.length >= maxResults) {
        truncated = true;
        return true;
      }
      if (visitedFiles >= defaultSearchMaxVisitedFiles || scannedBytes >= defaultSearchMaxBytes) {
        truncated = true;
        return true;
      }
      visitedFiles += 1;
      const remainingBytes = defaultSearchMaxBytes - scannedBytes;
      const buffer = this.readSearchBuffer(absolutePath, remainingBytes);
      if (buffer === null) {
        return false;
      }
      scannedBytes += buffer.byteLength;
      if (buffer.truncated) {
        truncated = true;
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
          truncated = true;
          return true;
        }
      }
      return false;
    });

    return {
      query,
      matches,
      truncated
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
    const imageMediaType = this.imageMediaTypeForPath(relativePath);
    if (imageMediaType !== null) {
      if (stat.size > maxBytes) {
        return {
          relativePath,
          kind: 'binary',
          mediaType: imageMediaType,
          content: '',
          truncated: true,
          sizeBytes: stat.size
        };
      }
      const imageBuffer = readFileSync(absolutePath);
      return {
        relativePath,
        kind: 'image',
        mediaType: imageMediaType,
        content: `data:${imageMediaType};base64,${imageBuffer.toString('base64')}`,
        truncated: false,
        sizeBytes: imageBuffer.byteLength
      };
    }
    if (this.isPdfPath(relativePath)) {
      return {
        relativePath,
        kind: 'binary',
        mediaType: 'application/pdf',
        content: 'PDF 文件需要在文件工作台中预览。',
        truncated: false,
        sizeBytes: stat.size
      };
    }
    const buffer = this.readFilePrefix(absolutePath, Math.min(stat.size, Math.max(maxBytes, binaryProbeBytes)));
    if (this.isBinaryBuffer(buffer)) {
      return {
        relativePath,
        kind: 'binary',
        content: '',
        truncated: stat.size > buffer.byteLength,
        sizeBytes: stat.size
      };
    }

    return {
      relativePath,
      kind: 'text',
      content: buffer.subarray(0, maxBytes).toString('utf8'),
      truncated: stat.size > maxBytes,
      sizeBytes: stat.size
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

  deleteFile(relativePathInput: string): FileDeleteResult {
    const relativePath = this.normalizeRelativePath(relativePathInput);
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    if (!existsSync(absolutePath)) {
      throw new RocDomainError({
        code: 'delete_file_target_missing',
        message: '要删除的目标不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请确认目标路径后重试。'
      });
    }
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      const children = readdirSync(absolutePath);
      if (children.length > 0) {
        throw new RocDomainError({
          code: 'delete_file_target_not_empty',
          message: '只能删除空目录。',
          category: 'validation',
          retryable: false,
          userAction: '请先清空目录内容，或改为删除具体文件。'
        });
      }
    }
    const recoveryPoint = this.createRecoveryPoint(relativePath, absolutePath, 'agent.delete_file');
    if (stat.isDirectory()) {
      rmdirSync(absolutePath);
    } else {
      unlinkSync(absolutePath);
    }
    return {
      relativePath,
      recoveryPoint
    };
  }

  readPdfWorkbenchPreview(request: FilesWorkbenchPdfPreviewRequest): FilesWorkbenchPdfPreviewResult {
    const relativePath = this.normalizeRelativePath(request.relativePath);
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    this.workspaceService.assertRealPathInsideWorkspace(absolutePath);
    const stat = statSync(absolutePath);
    if (!stat.isFile() || !this.isPdfPath(relativePath)) {
      throw new RocDomainError({
        code: 'file_preview_not_pdf',
        message: 'PDF 预览目标必须是 PDF 文件。',
        category: 'validation',
        retryable: false,
        userAction: '请选择一个 PDF 文件。'
      });
    }
    return {
      relativePath,
      resourceUrl: `roc-preview://workspace/pdf/${encodeURIComponent(relativePath)}#toolbar=0&navpanes=0&scrollbar=0`,
      sizeBytes: stat.size,
      mediaType: 'application/pdf'
    };
  }

  streamPdfPreviewResource(relativePathInput: string): Response {
    const relativePath = this.normalizeRelativePath(decodeURIComponent(relativePathInput));
    if (!this.isPdfPath(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    this.workspaceService.assertRealPathInsideWorkspace(absolutePath);
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      return new Response('Not found', { status: 404 });
    }
    // Node 和 DOM 的 ReadableStream 类型声明不互通；Response 运行时接受这个 Web stream。
    const stream = Readable.toWeb(createReadStream(absolutePath)) as unknown as BodyInit;
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'cache-control': 'no-store'
      }
    });
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

  private readSearchBuffer(absolutePath: string, maxBytes: number): (Buffer & { truncated: boolean }) | null {
    try {
      const stat = statSync(absolutePath);
      if (!stat.isFile()) {
        return null;
      }
      const buffer = this.readFilePrefix(absolutePath, Math.min(stat.size, maxBytes)) as Buffer & { truncated: boolean };
      buffer.truncated = stat.size > buffer.byteLength;
      return buffer;
    } catch (error) {
      if (this.isRecoverableFileSystemError(error)) {
        return null;
      }
      throw error;
    }
  }

  private readFilePrefix(absolutePath: string, byteLimit: number): Buffer {
    const targetBytes = Math.max(0, byteLimit);
    const buffer = Buffer.alloc(targetBytes);
    const fd = openSync(absolutePath, 'r');
    try {
      const bytesRead = readSync(fd, buffer, 0, targetBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
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

  private imageMediaTypeForPath(relativePath: string): string | null {
    const normalized = relativePath.toLowerCase();
    for (const [extension, mediaType] of imageMediaTypes.entries()) {
      if (normalized.endsWith(extension)) {
        return mediaType;
      }
    }
    return null;
  }

  private isPdfPath(relativePath: string): boolean {
    return relativePath.toLowerCase().endsWith('.pdf');
  }
}
