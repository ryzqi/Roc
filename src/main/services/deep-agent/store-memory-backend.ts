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
import {
  MAX_MEMORY_TOPICS_PER_SCOPE,
  MEMORY_TOPIC_DIRECTORY,
  MEMORY_WHITELIST_ERROR,
  parseMemoryTopicStoreKey
} from '../memory/store-slots';

const emptyOldStringError = 'Edit failed: oldString must not be empty.';

const topicLimitError = [
  `Write blocked: topic file limit reached (${MAX_MEMORY_TOPICS_PER_SCOPE}).`,
  'Merge or delete an existing topic file before creating a new one.'
].join('\n');

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
      files: result.files.filter((file) => file.is_dir || this.isAllowedKey(file.path))
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
        matches: result.matches.filter((match) => this.isAllowedKey(match.path))
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
      files: result.files.filter((file) => file.is_dir || this.isAllowedKey(file.path))
    };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const validation = this.validateWrite(filePath, content);
    if (!validation.ok) {
      return { error: validation.detail };
    }
    const topicLimit = await this.validateTopicLimit(filePath);
    if (!topicLimit.ok) {
      return { error: topicLimit.detail };
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

  /**
   * DeepAgents 的 memory middleware 通过 downloadFiles 加载记忆源，因此白名单路径必须返回真实字节。
   * 非白名单路径返回 file_not_found（而不是 permission_denied）：loadMemoryFromBackend 只把
   * file_not_found 当作“没有这个文件”，其它错误会抛异常并让整批记忆加载失败。
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const allowedPaths = paths.filter((path) => this.isAllowedKey(path));
    const downloaded =
      allowedPaths.length === 0 ? [] : await this.delegate.downloadFiles(allowedPaths);
    const byPath = new Map(downloaded.map((response) => [response.path, response]));
    return paths.map((path) => {
      const response = byPath.get(path);
      if (response !== undefined) {
        return response;
      }
      return { path, content: null, error: 'file_not_found' };
    });
  }

  private isAllowedKey(filePath: string): boolean {
    return this.resolveKind(filePath) !== null;
  }

  /** 白名单固定文件返回自身 kind；主题文件统一按 memory 限额计算。 */
  private resolveKind(filePath: string): MemoryKind | null {
    if (this.allowedKeys.has(filePath)) {
      return this.kindByKey.get(filePath) ?? null;
    }
    return parseMemoryTopicStoreKey(filePath) === null ? null : 'memory';
  }

  private validateKey(filePath: string): { ok: true; kind: MemoryKind } | { ok: false; detail: string } {
    const kind = this.resolveKind(filePath);
    if (kind === null) {
      return { ok: false, detail: MEMORY_WHITELIST_ERROR };
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

  /** 新建主题文件时校验数量上限；覆盖已存在的主题文件不受限制。 */
  private async validateTopicLimit(filePath: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (parseMemoryTopicStoreKey(filePath) === null) {
      return { ok: true };
    }
    const listing = await this.delegate.ls(`/${MEMORY_TOPIC_DIRECTORY}`);
    if (listing.error !== undefined || listing.files === undefined) {
      return { ok: true };
    }
    const existing = listing.files.filter((file) => !file.is_dir && parseMemoryTopicStoreKey(file.path) !== null);
    if (existing.some((file) => file.path === filePath)) {
      return { ok: true };
    }
    if (existing.length >= MAX_MEMORY_TOPICS_PER_SCOPE) {
      return { ok: false, detail: topicLimitError };
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
