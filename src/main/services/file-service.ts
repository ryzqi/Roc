import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import type {
  FileDeleteResult,
  FileNameSearchRequest,
  FileNameSearchResult,
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
import {
  ignoredFileNameSearchDirectories,
  isIgnoredFileNameSearchDirectory
} from './file-name-search-path-policy';
import type { RocPaths } from './paths';
import { RipgrepService } from './ripgrep-service';
import type { WorkspaceService } from './workspace-service';

const defaultPreviewBytes = 64 * 1024;
const defaultListLimit = 200;
const defaultSearchLimit = 100;
const binaryProbeBytes = 4096;
// 仅作为 ripgrep 缺失时的降级路径上限：rg 存在时搜索由它自己的遍历与 `--max-filesize` 承担。
const defaultSearchMaxVisitedFiles = 2000;
const defaultSearchMaxBytes = 4 * 1024 * 1024;
const defaultNameSearchLimit = 20;
const defaultNameSearchMaxVisitedFiles = 20000;
const defaultNameSearchSnapshotReconcileMs = 60_000;
const maxCachedNameSearchSnapshots = 4;
const imageMediaTypes = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml']
]);
export type FileRecoveryPointDatabase = {
  readonly db: DatabaseConnection;
};

type FileNamePathSnapshotDiagnosticEvent =
  | {
      event: 'build';
      workspacePath: string;
      buildCount: number;
      durationMs: number;
      reason: string;
      generation: number;
      entryCount: number;
      truncated: boolean;
      committed: boolean;
    }
  | {
      event: 'build-failed';
      workspacePath: string;
      buildCount: number;
      durationMs: number;
      reason: string;
      generation: number;
      error: string;
      stale: boolean;
    }
  | {
      event: 'invalidation';
      workspacePath: string;
      reason: string;
      generation: number | null;
      hadSnapshot: boolean;
      buildInFlight: boolean;
    };

export type FileServiceOptions = {
  /** Reconcile cached paths after this many milliseconds, even without watcher events. */
  pathSnapshotReconcileMs?: number;
  /** Reports path snapshot builds and invalidations without coupling the service to a logger. */
  onPathSnapshotDiagnostic?: (event: FileNamePathSnapshotDiagnosticEvent) => void;
};

type FileNamePathSnapshotEntry = {
  name: string;
  relativePath: string;
  normalizedName: string;
  normalizedPath: string;
};

type FileNamePathSnapshot = {
  entries: FileNamePathSnapshotEntry[];
  truncated: boolean;
};

type CachedFileNamePathSnapshot = {
  snapshot: FileNamePathSnapshot;
  builtAt: number;
};

type FileNamePathSnapshotState = {
  generation: number;
  snapshot: CachedFileNamePathSnapshot | null;
  buildPromise: Promise<FileNamePathSnapshot> | null;
  buildCount: number;
  nextBuildReason: string;
};

export class FileService {
  private readonly pathSnapshotReconcileMs: number;
  private readonly fileNamePathSnapshots = new Map<string, FileNamePathSnapshotState>();

  constructor(
    private readonly paths: RocPaths,
    private readonly database: FileRecoveryPointDatabase,
    private readonly workspaceService: WorkspaceService,
    private readonly ripgrep = new RipgrepService(),
    private readonly options: FileServiceOptions = {}
  ) {
    this.pathSnapshotReconcileMs = options.pathSnapshotReconcileMs ?? defaultNameSearchSnapshotReconcileMs;
    if (!Number.isSafeInteger(this.pathSnapshotReconcileMs) || this.pathSnapshotReconcileMs <= 0) {
      throw new RangeError('file_name_snapshot_reconcile_interval_invalid');
    }
  }

  async listTree(request: FileTreeRequest): Promise<FileTreeResult> {
    const workspace = this.workspaceService.requireWorkspace();
    const relativePath = this.normalizeRelativePath(request.relativePath);
    const target = this.workspaceService.resolveInsideWorkspace(relativePath);
    const directoryStat = await stat(target);
    if (!directoryStat.isDirectory()) {
      throw new RocDomainError({
        code: 'file_tree_target_not_directory',
        message: '文件树目标必须是目录。',
        category: 'validation',
        retryable: false,
        userAction: '请选择一个目录。'
      });
    }

    const limit = this.positiveLimit(request.limit, defaultListLimit);
    const children = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => !isIgnoredFileNameSearchDirectory(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    const visibleChildren = children.slice(0, limit);
    const entries = await Promise.all(visibleChildren.map(async (entry) => {
      const absolutePath = join(target, entry.name);
      const entryStat = await stat(absolutePath);
      return {
        name: entry.name,
        relativePath: this.toWorkspaceRelativePath(workspace.path, absolutePath),
        type: entry.isDirectory() ? 'directory' as const : 'file' as const,
        size: entryStat.size,
        updatedAt: entryStat.mtime.toISOString()
      };
    }));

    return {
      workspacePath: workspace.path,
      relativePath,
      entries,
      truncated: children.length > visibleChildren.length
    };
  }

  /**
   * 内容搜索：优先 ripgrep，缺失时退回逐文件扫描。
   *
   * 降级路径保留的原因不是怀旧：`ripgrep-binaries` 是随包资源，被误删、被 Gatekeeper 拒绝执行、
   * 或跑在未打分的开发树里都可能拿不到可执行文件。那时宁可慢，也要让 ⌘K 还能搜到东西。
   * 目录黑名单与 `visitFiles` 共用同一份 `ignoredDirectoryNames`，两条路径不各说各话。
   */
  async search(request: FileSearchRequest): Promise<FileSearchResult> {
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
    const ripgrepResult = await this.searchWithRipgrep(workspace.path, query, maxResults);
    if (ripgrepResult !== null) {
      return { query, ...ripgrepResult };
    }

    const matches: FileSearchResult['matches'] = [];
    let truncated = false;
    let visitedFiles = 0;
    let scannedBytes = 0;
    await this.visitFiles(workspace.path, async (absolutePath) => {
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
      const buffer = await this.readSearchBuffer(absolutePath, remainingBytes);
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

  private async searchWithRipgrep(
    rootDir: string,
    query: string,
    maxResults: number
  ): Promise<Pick<FileSearchResult, 'matches' | 'truncated'> | null> {
    if (!this.ripgrep.isAvailable()) {
      return null;
    }
    try {
      const result = await this.ripgrep.search({
        rootDir,
        query,
        maxResults,
        // 与旧扫描对齐：点文件也算（`.env` 里的关键词要能搜到），且不读 `.gitignore` /
        // `.ignore` / 全局 gitignore——目录过滤只认 file-name-search-path-policy，
        // 文件名快照和 ripgrep 都使用同一份目录列表。
        includeHidden: true,
        disableIgnoreRules: true,
        excludeDirectories: [...ignoredFileNameSearchDirectories],
        maxFileSizeBytes: defaultSearchMaxBytes
      });
      return {
        matches: result.matches.map((match) => ({
          relativePath: match.relativePath,
          line: match.line,
          column: match.column,
          preview: match.preview
        })),
        truncated: result.truncated
      };
    } catch {
      // rg 不存在、被杀或目标不可读都走降级；搜索失败不该让面板变红，只是变慢。
      return null;
    }
  }

  async searchByName(request: FileNameSearchRequest): Promise<FileNameSearchResult> {
    const query = request.query.trim();
    const workspace = this.workspaceService.requireWorkspace();
    const maxResults = this.positiveLimit(request.maxResults, defaultNameSearchLimit);
    const normalizedQuery = query.toLowerCase();
    const snapshot = await this.getFileNamePathSnapshot(workspace.path, workspace.id);
    if (normalizedQuery.length === 0) {
      return {
        query,
        matches: snapshot.entries.slice(0, maxResults).map(({ name, relativePath }) => ({ name, relativePath })),
        truncated: snapshot.truncated || snapshot.entries.length > maxResults
      };
    }

    const candidates: FileNameSearchCandidate[] = [];
    for (const entry of snapshot.entries) {
      const basenameHit = this.isSubsequenceMatch(normalizedQuery, entry.normalizedName);
      if (!basenameHit && !this.isSubsequenceMatch(normalizedQuery, entry.normalizedPath)) {
        continue;
      }
      candidates.push({ name: entry.name, relativePath: entry.relativePath, basenameHit });
    }
    candidates.sort(compareFileNameSearchCandidates);

    return {
      query,
      matches: candidates.slice(0, maxResults).map(({ name, relativePath }) => ({ name, relativePath })),
      truncated: snapshot.truncated || candidates.length > maxResults
    };
  }

  /** Invalidate cached paths after a known path-structure change or watcher failure. */
  invalidateFileNameSnapshot(workspacePath: string, reason = 'external-path-change'): void {
    const state = this.fileNamePathSnapshots.get(workspacePath);
    if (state === undefined) {
      this.options.onPathSnapshotDiagnostic?.({
        event: 'invalidation',
        workspacePath,
        reason,
        generation: null,
        hadSnapshot: false,
        buildInFlight: false
      });
      return;
    }
    const hadSnapshot = state.snapshot !== null;
    const buildInFlight = state.buildPromise !== null;
    state.generation += 1;
    state.snapshot = null;
    state.nextBuildReason = reason;
    this.options.onPathSnapshotDiagnostic?.({
      event: 'invalidation',
      workspacePath,
      reason,
      generation: state.generation,
      hadSnapshot,
      buildInFlight
    });
  }

  /** Returns whether a path is part of the current cached snapshot for the supplied root. */
  hasFileNamePathSnapshotEntry(workspacePath: string, relativePath: string): boolean {
    const snapshot = this.fileNamePathSnapshots.get(workspacePath)?.snapshot?.snapshot;
    return snapshot?.entries.some((entry) => entry.relativePath === relativePath) ?? false;
  }

  /** Drop all cached paths when the selected workspace changes. */
  invalidateAllFileNameSnapshots(reason = 'workspace-selection-change'): void {
    for (const workspacePath of this.fileNamePathSnapshots.keys()) {
      this.invalidateFileNameSnapshot(workspacePath, reason);
    }
  }

  private async getFileNamePathSnapshot(workspacePath: string, workspaceId: string): Promise<FileNamePathSnapshot> {
    while (true) {
      this.ensureWorkspaceSelection(workspaceId);
      const state = this.fileNamePathSnapshots.get(workspacePath) ?? this.createFileNamePathSnapshotState(workspacePath);
      const now = Date.now();
      const cached = state.snapshot;
      if (cached !== null && now - cached.builtAt < this.pathSnapshotReconcileMs) {
        this.touchFileNamePathSnapshot(workspacePath, state);
        return cached.snapshot;
      }
      if (cached !== null) state.nextBuildReason = 'reconcile';

      let buildPromise = state.buildPromise;
      if (buildPromise === null) {
        buildPromise = this.buildStableFileNamePathSnapshot(workspacePath, workspaceId, state);
        state.buildPromise = buildPromise;
      }

      let snapshot: FileNamePathSnapshot;
      try {
        snapshot = await buildPromise;
      } catch (error) {
        if (state.buildPromise !== buildPromise || this.fileNamePathSnapshots.get(workspacePath) !== state) {
          continue;
        }
        state.buildPromise = null;
        throw error;
      }

      if (state.buildPromise !== buildPromise || this.fileNamePathSnapshots.get(workspacePath) !== state) {
        continue;
      }
      this.ensureWorkspaceSelection(workspaceId);
      if (state.snapshot === null || state.snapshot.snapshot !== snapshot) {
        state.buildPromise = null;
        continue;
      }
      state.buildPromise = null;
      this.touchFileNamePathSnapshot(workspacePath, state);
      return snapshot;
    }
  }

  private async buildStableFileNamePathSnapshot(
    workspacePath: string,
    workspaceId: string,
    state: FileNamePathSnapshotState
  ): Promise<FileNamePathSnapshot> {
    while (true) {
      this.ensureWorkspaceSelection(workspaceId);
      const generation = state.generation;
      const reason = state.nextBuildReason;
      const buildCount = ++state.buildCount;
      const startedAt = performance.now();
      try {
        const snapshot = await this.buildFileNamePathSnapshot(workspacePath);
        const committed = state.generation === generation && this.fileNamePathSnapshots.get(workspacePath) === state;
        if (committed) {
          state.snapshot = { snapshot, builtAt: Date.now() };
          state.nextBuildReason = 'reconcile';
        }
        this.options.onPathSnapshotDiagnostic?.({
          event: 'build',
          workspacePath,
          buildCount,
          durationMs: performance.now() - startedAt,
          reason,
          generation,
          entryCount: snapshot.entries.length,
          truncated: snapshot.truncated,
          committed
        });
        if (committed) return snapshot;
      } catch (error) {
        const stale = state.generation !== generation || this.fileNamePathSnapshots.get(workspacePath) !== state;
        this.options.onPathSnapshotDiagnostic?.({
          event: 'build-failed',
          workspacePath,
          buildCount,
          durationMs: performance.now() - startedAt,
          reason,
          generation,
          error: error instanceof Error ? error.message : String(error),
          stale
        });
        if (!stale) throw error;
      }
    }
  }

  private ensureWorkspaceSelection(workspaceId: string): void {
    if (this.workspaceService.getCurrentWorkspace()?.id === workspaceId) return;
    throw new RocDomainError({
      code: 'file_name_search_workspace_changed',
      message: '工作区已切换，文件名搜索已取消。',
      category: 'conflict',
      retryable: true,
      userAction: '请在当前工作区重新搜索。'
    });
  }

  private createFileNamePathSnapshotState(workspacePath: string): FileNamePathSnapshotState {
    const state: FileNamePathSnapshotState = {
      generation: 0,
      snapshot: null,
      buildPromise: null,
      buildCount: 0,
      nextBuildReason: 'initial'
    };
    this.fileNamePathSnapshots.set(workspacePath, state);
    this.trimFileNamePathSnapshots(workspacePath);
    return state;
  }

  private touchFileNamePathSnapshot(workspacePath: string, state: FileNamePathSnapshotState): void {
    if (this.fileNamePathSnapshots.get(workspacePath) !== state) return;
    this.fileNamePathSnapshots.delete(workspacePath);
    this.fileNamePathSnapshots.set(workspacePath, state);
    this.trimFileNamePathSnapshots(workspacePath);
  }

  private trimFileNamePathSnapshots(currentWorkspacePath: string): void {
    for (const [workspacePath, state] of this.fileNamePathSnapshots) {
      if (this.fileNamePathSnapshots.size <= maxCachedNameSearchSnapshots) return;
      if (workspacePath === currentWorkspacePath || state.buildPromise !== null) continue;
      this.fileNamePathSnapshots.delete(workspacePath);
    }
  }

  private async buildFileNamePathSnapshot(workspacePath: string): Promise<FileNamePathSnapshot> {
    const entries: FileNamePathSnapshotEntry[] = [];
    let truncated = false;
    let visitedFiles = 0;
    await this.visitFiles(workspacePath, (absolutePath) => {
      if (visitedFiles >= defaultNameSearchMaxVisitedFiles) {
        truncated = true;
        return true;
      }
      visitedFiles += 1;
      const relativePath = this.toWorkspaceRelativePath(workspacePath, absolutePath);
      const name = this.fileNameFromRelativePath(relativePath);
      entries.push({
        name,
        relativePath,
        normalizedName: name.toLowerCase(),
        normalizedPath: relativePath.toLowerCase()
      });
      return false;
    });
    return { entries, truncated };
  }

  async readPreview(request: FilePreviewRequest): Promise<FilePreviewResult> {
    const relativePath = this.normalizeRelativePath(request.relativePath);
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
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
      if (fileStat.size > maxBytes) {
        return {
          relativePath,
          kind: 'binary',
          mediaType: imageMediaType,
          content: '',
          truncated: true,
          sizeBytes: fileStat.size
        };
      }
      const imageBuffer = await readFile(absolutePath);
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
        sizeBytes: fileStat.size
      };
    }
    const buffer = await this.readFilePrefixAsync(absolutePath, Math.min(fileStat.size, Math.max(maxBytes, binaryProbeBytes)));
    if (this.isBinaryBuffer(buffer)) {
      return {
        relativePath,
        kind: 'binary',
        content: '',
        truncated: fileStat.size > buffer.byteLength,
        sizeBytes: fileStat.size
      };
    }

    return {
      relativePath,
      kind: 'text',
      content: buffer.subarray(0, maxBytes).toString('utf8'),
      truncated: fileStat.size > maxBytes,
      sizeBytes: fileStat.size
    };
  }

  async writeTextFile(request: FileWriteTextRequest): Promise<FileWriteResult> {
    const workspacePath = this.workspaceService.requireWorkspace().path;
    const relativePath = this.normalizeRelativePath(request.relativePath);
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    const { recoveryPoint, sourceExisted } = await this.createRecoveryPoint(relativePath, absolutePath, request.source);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, request.content, 'utf8');
    if (!sourceExisted) this.invalidateFileNameSnapshot(workspacePath, 'files.writeText.created');

    return {
      relativePath,
      recoveryPoint,
      bytesWritten: Buffer.byteLength(request.content, 'utf8')
    };
  }

  async deleteFile(relativePathInput: string): Promise<FileDeleteResult> {
    const workspacePath = this.workspaceService.requireWorkspace().path;
    const relativePath = this.normalizeRelativePath(relativePathInput);
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch (error) {
      if (this.isRecoverableFileSystemError(error) && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RocDomainError({
          code: 'delete_file_target_missing',
          message: '要删除的目标不存在。',
          category: 'not_found',
          retryable: false,
          userAction: '请确认目标路径后重试。'
        });
      }
      throw error;
    }
    if (fileStat.isDirectory()) {
      const children = await readdir(absolutePath);
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
    const { recoveryPoint } = await this.createRecoveryPoint(relativePath, absolutePath, 'agent.delete_file');
    if (fileStat.isDirectory()) {
      await rmdir(absolutePath);
    } else {
      await unlink(absolutePath);
    }
    this.invalidateFileNameSnapshot(workspacePath, 'files.delete');
    return { relativePath, recoveryPoint };
  }

  async readPdfWorkbenchPreview(request: FilesWorkbenchPdfPreviewRequest): Promise<FilesWorkbenchPdfPreviewResult> {
    const relativePath = this.normalizeRelativePath(request.relativePath);
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    await this.workspaceService.assertRealPathInsideWorkspace(absolutePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || !this.isPdfPath(relativePath)) {
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
      sizeBytes: fileStat.size,
      mediaType: 'application/pdf'
    };
  }

  async streamPdfPreviewResource(relativePathInput: string): Promise<Response> {
    const relativePath = this.normalizeRelativePath(decodeURIComponent(relativePathInput));
    if (!this.isPdfPath(relativePath)) {
      return new Response('Not found', { status: 404 });
    }
    const absolutePath = this.workspaceService.resolveInsideWorkspace(relativePath);
    await this.workspaceService.assertRealPathInsideWorkspace(absolutePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      return new Response('Not found', { status: 404 });
    }
    // SAFETY: Node's Readable.toWeb returns a Web ReadableStream accepted by Response at runtime; the Node and DOM declarations are incompatible.
    const stream = Readable.toWeb(createReadStream(absolutePath)) as unknown as BodyInit;
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'cache-control': 'no-store'
      }
    });
  }


  private async copyRecoverySnapshot(
    sourcePath: string,
    snapshotPath: string
  ): Promise<{ contentSha256: string; sourceExisted: boolean }> {
    try {
      await stat(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await writeFile(snapshotPath, Buffer.alloc(0));
        return { contentSha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), sourceExisted: false };
      }
      throw error;
    }
    const hash = createHash('sha256');
    await pipeline(
      createReadStream(sourcePath),
      async function* (chunks: AsyncIterable<Buffer | string>) {
        for await (const chunk of chunks) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          hash.update(buffer);
          yield buffer;
        }
      },
      createWriteStream(snapshotPath)
    );
    return { contentSha256: hash.digest('hex'), sourceExisted: true };
  }

  private async createRecoveryPoint(
    relativePath: string,
    absolutePath: string,
    source: string
  ): Promise<{ recoveryPoint: RecoveryPoint; sourceExisted: boolean }> {
    const createdAt = new Date().toISOString();
    const id = `recovery_${randomUUID()}`;
    const snapshotDir = join(this.paths.tasksDir, 'recovery', id);
    await mkdir(snapshotDir, { recursive: true });
    const snapshotPath = join(snapshotDir, 'original');
    const { contentSha256, sourceExisted } = await this.copyRecoverySnapshot(absolutePath, snapshotPath);
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

    return { recoveryPoint, sourceExisted };
  }

  private async visitFiles(root: string, visit: (absolutePath: string) => boolean | Promise<boolean>): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (this.isRecoverableFileSystemError(error)) {
        return false;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && isIgnoredFileNameSearchDirectory(entry.name)) {
        continue;
      }

      const absolutePath = join(root, entry.name);
      if (entry.isDirectory()) {
        if (await this.visitFiles(absolutePath, visit)) {
          return true;
        }
        continue;
      }
      if (entry.isFile()) {
        if (await visit(absolutePath)) {
          return true;
        }
      }
    }
    return false;
  }

  private async readSearchBuffer(absolutePath: string, maxBytes: number): Promise<(Buffer & { truncated: boolean }) | null> {
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        return null;
      }
      const buffer = await this.readFilePrefixAsync(absolutePath, Math.min(fileStat.size, maxBytes)) as Buffer & { truncated: boolean };
      buffer.truncated = fileStat.size > buffer.byteLength;
      return buffer;
    } catch (error) {
      if (this.isRecoverableFileSystemError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async readFilePrefixAsync(absolutePath: string, byteLimit: number): Promise<Buffer> {
    const targetBytes = Math.max(0, byteLimit);
    const handle = await open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(targetBytes);
      const { bytesRead } = await handle.read(buffer, 0, targetBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
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
    return trimmed;
  }

  private toWorkspaceRelativePath(workspacePath: string, absolutePath: string): string {
    return relative(workspacePath, absolutePath);
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

  private fileNameFromRelativePath(relativePath: string): string {
    const separatorIndex = relativePath.lastIndexOf('/');
    return separatorIndex === -1 ? relativePath : relativePath.slice(separatorIndex + 1);
  }

  private isSubsequenceMatch(query: string, target: string): boolean {
    let queryIndex = 0;
    for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
      if (target[targetIndex] === query[queryIndex]) {
        queryIndex += 1;
      }
    }
    return queryIndex === query.length;
  }
}

type FileNameSearchCandidate = {
  name: string;
  relativePath: string;
  basenameHit: boolean;
};

function compareFileNameSearchCandidates(left: FileNameSearchCandidate, right: FileNameSearchCandidate): number {
  if (left.basenameHit !== right.basenameHit) {
    return left.basenameHit ? -1 : 1;
  }
  if (left.relativePath.length !== right.relativePath.length) {
    return left.relativePath.length - right.relativePath.length;
  }
  return left.relativePath.localeCompare(right.relativePath);
}
