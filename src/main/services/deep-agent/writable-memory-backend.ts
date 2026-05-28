import type {
  EditResult,
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
  FilesystemBackend,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2,
  WriteResult
} from 'deepagents';
import type { MemoryKind } from '../../../shared/types';
import { CapacityService } from '../memory/capacity';
import { resolveMemoryPath } from '../memory/path-resolver';
import { SecurityScanService } from '../memory/security-scan';

const NOT_SUPPORTED = 'Operation not supported on /memory/.';
const BINARY_EDIT_UNSUPPORTED = 'Memory file is binary, edit not supported.';
const EMPTY_OLD_STRING = 'Edit failed: oldString must not be empty.';

export class WritableMemoryFilesystemBackend implements SandboxBackendProtocolV2 {
  readonly id = 'roc-memory-writable';

  constructor(
    private readonly delegate: FilesystemBackend,
    private readonly workspaceHash: string | null,
    private readonly securityScan: SecurityScanService,
    private readonly capacity: CapacityService,
    private readonly onCapacityOverflow?: (resolved: string, kind: MemoryKind) => void
  ) {}

  ls(path: string): Promise<LsResult> {
    return this.delegate.ls(this.stripMemoryPrefix(path));
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.delegate.read(this.stripMemoryPrefix(filePath), offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    return this.delegate.readRaw(this.stripMemoryPrefix(filePath));
  }

  grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    if (path === null || path === undefined) {
      return this.delegate.grep(pattern, undefined, glob);
    }
    return this.delegate.grep(pattern, this.stripMemoryPrefix(path), glob);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    if (path === undefined) {
      return this.delegate.glob(pattern, undefined);
    }
    return this.delegate.glob(pattern, this.stripMemoryPrefix(path));
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const resolved = resolveMemoryPath(this.asMemoryRoutePath(filePath), this.workspaceHash);
    if (!resolved.ok) {
      return { error: resolved.error };
    }
    return this.runWrite(resolved.resolved, resolved.kind, content);
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    if (oldString.length === 0) {
      return { error: EMPTY_OLD_STRING };
    }

    const resolved = resolveMemoryPath(this.asMemoryRoutePath(filePath), this.workspaceHash);
    if (!resolved.ok) {
      return { error: resolved.error };
    }

    const existing = await this.delegate.read(resolved.resolved);
    if (existing.error !== undefined) {
      return { error: existing.error };
    }
    if (existing.content instanceof Uint8Array) {
      return { error: BINARY_EDIT_UNSUPPORTED };
    }
    if (typeof existing.content !== 'string') {
      return { error: `Edit failed: no text content found in ${filePath}` };
    }

    const replacement = this.replaceContent(existing.content, oldString, newString, replaceAll === true);
    if (!replacement.ok) {
      return { error: `Edit failed: oldString not found in ${filePath}` };
    }

    const validationError = this.validateContent(resolved.resolved, resolved.kind, replacement.content);
    if (validationError !== null) {
      return { error: validationError };
    }

    const editResult = await this.delegate.edit(resolved.resolved, existing.content, replacement.content);
    if (editResult.error !== undefined) {
      return { error: editResult.error };
    }

    return {
      path: editResult.path,
      filesUpdate: editResult.filesUpdate,
      occurrences: replacement.occurrences,
      metadata: editResult.metadata
    };
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
    return this.delegate.downloadFiles(paths.map((path) => this.stripMemoryPrefix(path)));
  }

  execute(_command: string): Promise<ExecuteResponse> {
    return Promise.resolve({
      output: NOT_SUPPORTED,
      exitCode: 1,
      truncated: false
    });
  }

  private async runWrite(resolved: string, kind: MemoryKind, content: string): Promise<WriteResult> {
    const validationError = this.validateContent(resolved, kind, content);
    if (validationError !== null) {
      return { error: validationError };
    }

    return this.delegate.write(resolved, content);
  }

  private validateContent(resolved: string, kind: MemoryKind, content: string): string | null {
    const issues = this.securityScan.scan(content);
    if (issues.length > 0) {
      return this.securityScan.formatIssues(issues);
    }

    const capacity = this.capacity.check(kind, content);
    if (!capacity.ok) {
      if (this.onCapacityOverflow !== undefined) {
        this.onCapacityOverflow(resolved, kind);
      }
      return this.capacity.formatOverflow(kind, capacity.chars, capacity.limit);
    }

    return null;
  }

  private replaceContent(
    content: string,
    oldString: string,
    newString: string,
    replaceAll: boolean
  ): { ok: true; content: string; occurrences: number } | { ok: false } {
    if (replaceAll) {
      const parts = content.split(oldString);
      if (parts.length === 1) {
        return { ok: false };
      }
      return {
        ok: true,
        content: parts.join(newString),
        occurrences: parts.length - 1
      };
    }

    const index = content.indexOf(oldString);
    if (index === -1) {
      return { ok: false };
    }
    return {
      ok: true,
      content: content.slice(0, index) + newString + content.slice(index + oldString.length),
      occurrences: 1
    };
  }

  private asMemoryRoutePath(filePath: string): string {
    if (filePath.startsWith('/memory/')) {
      return filePath;
    }
    if (filePath.startsWith('/global/') || filePath.startsWith('/workspaces/')) {
      return `/memory${filePath}`;
    }
    return filePath;
  }

  private stripMemoryPrefix(path: string): string {
    if (path.startsWith('/memory/')) {
      return path.slice('/memory'.length);
    }
    return path;
  }
}
