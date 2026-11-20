import { applyGrepMaxCount } from 'deepagents';
import type { BaseStore } from '@langchain/langgraph';
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
import { readBackendSlice } from './backend-file-read';
import { parseAutoMemoryEntries, projectAutoMemoryScope } from '../memory/auto-memory-candidates';
import { CapacityService } from '../memory/capacity';
import { SecurityScanService } from '../memory/security-scan';
import { withStoreMemoryMutation } from '../memory/memory-mutations';
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
    private readonly kindByKey: ReadonlyMap<string, MemoryKind>,
    private readonly applicability: string,
    private readonly store: BaseStore,
    private readonly canWrite: () => boolean = () => true
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

  async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return readBackendSlice(await this.readRaw(filePath), offset, limit);
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const validation = this.validateKey(filePath);
    if (!validation.ok) return { error: validation.detail };
    const raw = await this.delegate.readRaw(filePath);
    if (raw.error !== undefined || raw.data === undefined) return raw;
    if (typeof raw.data.content !== 'string') return { error: 'memory_text_format_required' };
    const content = (await this.projectScope()).get(filePath);
    if (content === undefined) return { error: 'memory_scope_file_missing' };
    return { data: { ...raw.data, content, mimeType: 'text/markdown' } };
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
    const projected = new Map<string, string[]>();
    for (const path of new Set(result.matches.filter(match => this.isAllowedKey(match.path)).map(match => match.path))) {
      const raw = await this.readRaw(path);
      if (raw.error !== undefined || raw.data === undefined || typeof raw.data.content !== 'string') {
        return { error: raw.error ?? 'memory_projection_read_failed' };
      }
      projected.set(path, raw.data.content.split('\n'));
    }
    return applyGrepMaxCount({
      result: { ...result, matches: result.matches.filter(match => projected.get(match.path)?.[match.line - 1] === match.text) },
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
    return withStoreMemoryMutation(this.store, () => this.writeLocked(filePath, content));
  }

  private async writeLocked(filePath: string, content: string): Promise<WriteResult> {
    if (!this.canWrite()) return { error: 'auto_memory_disabled' };
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
    return withStoreMemoryMutation(this.store, () => this.editLocked(filePath, oldString, newString, replaceAll));
  }

  private async editLocked(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    if (!this.canWrite()) return { error: 'auto_memory_disabled' };
    if (oldString.length === 0) {
      return { error: emptyOldStringError };
    }
    const keyValidation = this.validateKey(filePath);
    if (!keyValidation.ok) {
      return { error: keyValidation.detail };
    }
    // Edit the stored document, not a paginated read or the active-memory projection.
    const existing = await this.delegate.readRaw(filePath);
    if (existing.error !== undefined) {
      return { error: existing.error };
    }
    if (typeof existing.data?.content !== 'string') {
      return { error: `Edit failed: no text content found in ${filePath}` };
    }
    const replacement = replaceContent(existing.data.content, oldString, newString, replaceAll === true);
    if (!replacement.ok) {
      return { error: replacement.occurrences === 0
        ? `Edit failed: oldString not found in ${filePath}`
        : `Edit failed: oldString has multiple occurrences (${replacement.occurrences}) in ${filePath}. Use replace_all=True or provide more surrounding context.` };
    }
    const writeValidation = this.validateWrite(filePath, replacement.content);
    if (!writeValidation.ok) {
      return { error: writeValidation.detail };
    }
    // Persist exactly what was validated; delegate.edit would re-read and replace unvalidated text.
    // The shared store coordinator protects this snapshot from other main-process memory mutations.
    try {
      const result = await this.delegate.write(filePath, replacement.content);
      return result.error === undefined ? { ...result, occurrences: replacement.occurrences } : result;
    } catch (error) {
      return { error: `Edit failed: ${error instanceof Error ? error.message : String(error)}` };
    }
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
    const projected = await this.projectScope();
    return paths.map(path => {
      const content = projected.get(path);
      return content === undefined ? { path, content: null, error: 'file_not_found' as const } :
        { path, content: new TextEncoder().encode(content), error: null };
    });
  }

  private async projectScope(): Promise<Map<string, string>> {
    const listing = await this.delegate.glob('**/*', '/');
    if (listing.error !== undefined || listing.files === undefined) throw new Error(listing.error ?? 'memory_scope_listing_failed');
    const paths = listing.files.filter(file => !file.is_dir && this.isAllowedKey(file.path)).map(file => file.path);
    const contents: string[] = [];
    for (const path of paths) {
      const raw = await this.delegate.readRaw(path);
      if (raw.error !== undefined || raw.data === undefined || typeof raw.data.content !== 'string') throw new Error(raw.error ?? 'memory_scope_read_failed');
      contents.push(raw.data.content);
    }
    const projected = projectAutoMemoryScope(contents, this.applicability);
    return new Map(paths.map((path, index) => [path, projected[index]]));
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
    if (parseAutoMemoryEntries(content).some(entry => entry.parseError !== null)) {
      return { ok: false, detail: 'Write blocked: malformed memory entry. Correct the structured fields, then retry.' };
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
): { ok: true; content: string; occurrences: number } | { ok: false; occurrences: number } {
  const parts = content.split(oldString);
  const occurrences = parts.length - 1;
  if (occurrences === 0 || (occurrences > 1 && !replaceAll)) {
    return { ok: false, occurrences };
  }
  return { ok: true, content: parts.join(newString), occurrences };
}
