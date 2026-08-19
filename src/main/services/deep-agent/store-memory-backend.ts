import { applyGrepMaxCount } from 'deepagents';
import type {
  EditResult,
  FileDownloadResponse,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  StoreBackend,
  WriteResult
} from 'deepagents';

import type { MemoryKind } from '../../../shared/types';
import { CapacityService } from '../memory/capacity';
import { SecurityScanService } from '../memory/security-scan';

const whitelistError = [
  'Path not writable. Memory file whitelist:',
  '  /memory/global/USER.md',
  '  /memory/global/AGENTS.md  |  /memory/workspaces/current/AGENTS.md',
  '  /memory/global/MEMORY.md  |  /memory/workspaces/current/MEMORY.md'
].join('\n');

const emptyOldStringError = 'Edit failed: oldString must not be empty.';

export class RocStoreMemoryBackend {
  constructor(
    private readonly delegate: StoreBackend,
    private readonly allowedKeys: ReadonlySet<string>,
    private readonly securityScan: SecurityScanService,
    private readonly capacity: CapacityService,
    private readonly kindByKey: ReadonlyMap<string, MemoryKind>
  ) {}

  async ls(path: string): Promise<LsResult> {
    const result = await this.delegate.ls(path);
    if (result.error !== undefined || result.files === undefined) {
      return result;
    }
    return {
      files: result.files.filter((file) => file.is_dir || this.allowedKeys.has(file.path))
    };
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    const validation = this.validateKey(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.detail });
    }
    return this.delegate.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    const validation = this.validateKey(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.detail });
    }
    return this.delegate.readRaw(filePath);
  }

  async grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
    maxCount?: number | null
  ): Promise<GrepResult> {
    const result = await this.delegate.grep(pattern, path ?? undefined, glob ?? undefined);
    if (result.error !== undefined || result.matches === undefined) {
      return result;
    }
    return applyGrepMaxCount({
      result: {
        ...result,
        matches: result.matches.filter((match) => this.allowedKeys.has(match.path))
      },
      maxCount
    });
  }

  async glob(pattern: string, path?: string): Promise<GlobResult> {
    const result = await this.delegate.glob(pattern, path);
    if (result.error !== undefined || result.files === undefined) {
      return result;
    }
    return {
      ...result,
      files: result.files.filter((file) => file.is_dir || this.allowedKeys.has(file.path))
    };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const validation = this.validateWrite(filePath, content);
    if (!validation.ok) {
      return { error: validation.detail };
    }
    return await this.delegate.write(filePath, content);
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    if (oldString.length === 0) {
      return { error: emptyOldStringError };
    }
    const keyValidation = this.validateKey(filePath);
    if (!keyValidation.ok) {
      return { error: keyValidation.detail };
    }
    const existing = await this.delegate.read(filePath);
    if (existing.error !== undefined) {
      return { error: existing.error };
    }
    if (typeof existing.content !== 'string') {
      return { error: `Edit failed: no text content found in ${filePath}` };
    }
    const replacement = replaceContent(existing.content, oldString, newString, replaceAll === true);
    if (!replacement.ok) {
      return { error: `Edit failed: oldString not found in ${filePath}` };
    }
    const writeValidation = this.validateWrite(filePath, replacement.content);
    if (!writeValidation.ok) {
      return { error: writeValidation.detail };
    }
    return await this.delegate.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(files.map(([path]) => ({ path, error: 'permission_denied' })));
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return Promise.resolve(paths.map((path) => ({ path, content: null, error: 'permission_denied' })));
  }

  private validateKey(filePath: string): { ok: true; kind: MemoryKind } | { ok: false; detail: string } {
    if (!this.allowedKeys.has(filePath)) {
      return { ok: false, detail: whitelistError };
    }
    const kind = this.kindByKey.get(filePath);
    if (kind === undefined) {
      return { ok: false, detail: whitelistError };
    }
    return { ok: true, kind };
  }

  private validateWrite(filePath: string, content: string): { ok: true } | { ok: false; detail: string } {
    const key = this.validateKey(filePath);
    if (!key.ok) {
      return key;
    }
    const issues = this.securityScan.scan(content);
    if (issues.length > 0) {
      return { ok: false, detail: this.securityScan.formatIssues(issues) };
    }
    const capacity = this.capacity.check(key.kind, content);
    if (!capacity.ok) {
      return { ok: false, detail: this.capacity.formatOverflow(key.kind, capacity.chars, capacity.limit) };
    }
    return { ok: true };
  }
}

function replaceContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): { ok: true; content: string } | { ok: false } {
  if (replaceAll) {
    const parts = content.split(oldString);
    if (parts.length === 1) {
      return { ok: false };
    }
    return { ok: true, content: parts.join(newString) };
  }
  const index = content.indexOf(oldString);
  if (index === -1) {
    return { ok: false };
  }
  return { ok: true, content: content.slice(0, index) + newString + content.slice(index + oldString.length) };
}
