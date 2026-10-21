import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { applyGrepMaxCount, type FilesystemBackend, type LsResult, type ReadResult, type ReadRawResult,
  type GrepResult, type GlobResult, type EditResult, type WriteResult, type FileDownloadResponse, type FileUploadResponse } from 'deepagents';
import type { RunCapabilityManifestSkillV1 } from '../../../shared/types';
import { hashSkillBytes, readSkillRevision } from '../skill-revision';
import { readBackendSlice } from './backend-file-read';

const denied = 'Roc 当前回合未启用这个 skill。';
const readOnly = 'Roc 已将 /skills/ 挂载为只读能力目录。';

/** Only selected, frozen file bytes reach the model, including through grep and downloads. */
export class SelectedSkillsFilesystemBackend {
  private readonly selected = new Set<string>();
  private readonly files = new Map<string, string>();

  constructor(private readonly delegate: FilesystemBackend, root: string, skills: readonly RunCapabilityManifestSkillV1[]) {
    for (const skill of skills) {
      const id = skill.canonicalIdentity.slice('skill:'.length);
      if (!skill.canonicalIdentity.startsWith('skill:') || id.includes('/') || id === '..' || id === '.') throw new Error('skill_revision_identity_invalid');
      if (realpathSync(skill.sourcePath) !== realpathSync(join(root, id))) throw new Error('skill_revision_root_mismatch');
      const revision = readSkillRevision(skill.sourcePath);
      if (revision.contentHash !== skill.contentHash || revision.licenseHash !== skill.licenseHash) throw new Error('skill_revision_changed');
      this.selected.add(id);
      for (const file of revision.files) this.files.set(`${id}/${file.path}`, file.hash);
    }
  }

  async ls(path: string): Promise<LsResult> {
    if (path !== '/' && !this.allowed(path)) return { error: denied };
    const result = await this.delegate.ls(path);
    return result.files === undefined ? result : { ...result, files: result.files.filter(file => this.allowed(file.path)) };
  }

  async read(path: string, offset?: number, limit?: number): Promise<ReadResult> {
    return readBackendSlice(await this.readRaw(path), offset, limit);
  }

  async readRaw(path: string): Promise<ReadRawResult> {
    const expected = this.expected(path);
    if (expected === undefined) return { error: denied };
    const raw = await this.delegate.readRaw(path);
    if (raw.error !== undefined || raw.data === undefined) return raw;
    if (Array.isArray(raw.data.content)) return { error: 'skill_file_format_unsupported' };
    if (hashSkillBytes(raw.data.content) !== expected) return { error: 'skill_revision_changed' };
    return raw;
  }

  async grep(pattern: string, path?: string | null, glob?: string | null, maxCount?: number | null): Promise<GrepResult> {
    const roots = path === undefined || path === null || path === '/' ? [...this.selected].map(id => `/${id}/`) : [path];
    const matches: NonNullable<GrepResult['matches']> = [];
    for (const root of roots) {
      if (!this.allowed(root)) return { error: denied };
      const result = await this.delegate.grep(pattern, root, glob ?? undefined);
      if (result.error !== undefined) return result;
      const content = new Map<string, string[]>();
      for (const file of new Set(result.matches?.map(match => match.path))) {
        const raw = await this.readRaw(file);
        if (raw.error !== undefined || raw.data === undefined || typeof raw.data.content !== 'string') return { error: raw.error ?? 'skill_text_required' };
        content.set(file, raw.data.content.split('\n'));
      }
      matches.push(...(result.matches ?? []).filter(match => content.get(match.path)?.[match.line - 1] === match.text));
    }
    return applyGrepMaxCount({ result: { matches }, maxCount });
  }

  async glob(pattern: string, path?: string): Promise<GlobResult> {
    if (path !== undefined && path !== '/' && !this.allowed(path)) return { error: denied };
    const result = await this.delegate.glob(pattern, path);
    return result.files === undefined ? result : { ...result, files: result.files.filter(file => this.allowed(file.path)) };
  }

  write(_path: string, _content: string): Promise<WriteResult> { return Promise.resolve({ error: readOnly }); }
  edit(_path: string, _old: string, _replacement: string, _all?: boolean): Promise<EditResult> { return Promise.resolve({ error: readOnly }); }
  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(files.map(([path]) => ({ path, error: 'permission_denied' })));
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const allowed = paths.filter(path => this.expected(path) !== undefined);
    const downloaded = allowed.length === 0 ? [] : await this.delegate.downloadFiles(allowed);
    const byPath = new Map(downloaded.map(file => [file.path, file]));
    return paths.map(path => {
      const file = byPath.get(path);
      if (file === undefined) return { path, content: null, error: 'permission_denied' };
      if (file.content !== null && hashSkillBytes(file.content) !== this.expected(path)) throw new Error('skill_revision_changed');
      return file;
    });
  }

  private allowed(path: string): boolean {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter(Boolean);
    return this.selected.has(parts[0] ?? '') && !parts.some(part => ['.', '..', '.git', 'roc.skill.json', '.DS_Store'].includes(part));
  }

  private expected(path: string): string | undefined {
    return this.allowed(path) ? this.files.get(path.split('/').filter(Boolean).join('/')) : undefined;
  }
}
