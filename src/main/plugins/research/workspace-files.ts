import { randomUUID } from 'node:crypto';
import { link, lstat, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  researchWorkspaceFileContentSchema, researchWorkspaceFileSaveRequestSchema, researchWorkspaceFileSchema,
  type ResearchWorkspaceFileContent, type ResearchWorkspaceFileSaveRequest
} from '../../../shared/schemas/research-experiments';
import { createResearchDirectory, readResearchFile, researchAbsolutePath, researchContentHash, researchRelativePath, researchWorkspace } from './research-files';
import type { ResearchRepository } from './repository';

const editable = new Set(['.py', '.r', '.jl', '.csv', '.tsv', '.txt', '.md', '.json']);
const blocked = new Set(['.roc-research', '.roc-build', '.git', '.venv', 'node_modules', '__MACOSX']);

type Row = { path: string; sha256: string; size: number; revision: number; owner_run_id: string | null; updated_at: string };

export class ResearchWorkspaceFileService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  async read(projectId: string, path: string): Promise<ResearchWorkspaceFileContent> {
    const { root } = await this.context(projectId, false);
    this.requireEditable(path);
    const bytes = await readResearchFile(root, path, 1024 * 1024);
    const record = this.row(projectId, path);
    const sha256 = researchContentHash(bytes);
    if (record !== null && (record.sha256 !== sha256 || record.size !== bytes.byteLength)) throw new Error('research_workspace_file_conflict');
    return researchWorkspaceFileContentSchema.parse({
      projectId, path, sha256, size: bytes.byteLength, revision: record?.revision ?? 1,
      ownerRunId: record?.owner_run_id ?? null, updatedAt: record?.updated_at ?? this.now(),
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    });
  }

  async save(request: ResearchWorkspaceFileSaveRequest, ownerRunId: string | null = null): Promise<ResearchWorkspaceFileContent> {
    const input = researchWorkspaceFileSaveRequestSchema.parse(request);
    const { project, root } = await this.context(input.projectId, true);
    if (ownerRunId !== null) this.research.runs.requireActive(ownerRunId, project.id);
    this.requireEditable(input.path);
    const bytes = Buffer.from(input.content, 'utf8');
    if (bytes.byteLength > 1024 * 1024) throw new Error('research_workspace_file_too_large');
    const target = researchAbsolutePath(root, input.path);
    let original: Buffer | null = null;
    if (input.expectedHash === null) {
      try { await lstat(target); throw new Error('research_workspace_file_exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } else {
      original = await readResearchFile(root, input.path, 1024 * 1024);
      if (researchContentHash(original) !== input.expectedHash) throw new Error('research_workspace_file_conflict');
    }
    if (dirname(input.path) !== '.') await createResearchDirectory(root, dirname(input.path));
    const temporary = join(dirname(target), `.roc-edit-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    let published = false;
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (input.expectedHash === null) await link(temporary, target);
      else {
        if (researchContentHash(await readResearchFile(root, input.path, 1024 * 1024)) !== input.expectedHash) {
          throw new Error('research_workspace_file_conflict');
        }
        await rename(temporary, target);
      }
      published = true;
      await rm(temporary, { force: true });
      if (ownerRunId !== null) this.research.runs.requireActive(ownerRunId, project.id);
      const saved = this.persist(project.id, input.path, researchContentHash(bytes), bytes.byteLength, ownerRunId, input.expectedHash);
      return { ...saved, content: input.content };
    } catch (error) {
      if (published) await this.restore(root, input.path, researchContentHash(bytes), original);
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }

  private persist(projectId: string, path: string, sha256: string, size: number, ownerRunId: string | null, expectedHash: string | null) {
    return this.db.transaction(() => {
      if (ownerRunId !== null) this.research.runs.requireActive(ownerRunId, projectId);
      const current = this.row(projectId, path);
      if (expectedHash === null && current !== null) throw new Error('research_workspace_file_exists');
      if (expectedHash !== null && current !== null && current.sha256 !== expectedHash) throw new Error('research_workspace_file_conflict');
      const updatedAt = this.now();
      const revision = current === null ? 1 : current.revision + 1;
      this.db.prepare(`INSERT INTO research_workspace_files (project_id,path,sha256,size,revision,owner_run_id,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET
          sha256 = excluded.sha256, size = excluded.size, revision = excluded.revision,
          owner_run_id = excluded.owner_run_id, updated_at = excluded.updated_at`)
        .run(projectId, path, sha256, size, revision, ownerRunId, updatedAt);
      return researchWorkspaceFileSchema.parse({ projectId, path, sha256, size, revision, ownerRunId, updatedAt });
    })();
  }

  private async restore(root: string, path: string, writtenHash: string, original: Buffer | null): Promise<void> {
    const matches = async (): Promise<boolean> => {
      try { return researchContentHash(await readResearchFile(root, path, 1024 * 1024)) === writtenHash; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    if (!await matches()) return;
    const target = researchAbsolutePath(root, path);
    if (original === null) { await unlink(target); return; }
    const temporary = join(dirname(target), `.roc-rollback-${randomUUID()}`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(original); await handle.sync(); } finally { await handle.close(); }
      if (await matches()) await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }

  private async context(projectId: string, writable: boolean) {
    const project = this.research.getProject(projectId);
    if (writable && project.status === 'archived') throw new Error('research_project_archived');
    return { project, root: await researchWorkspace(project.workspacePath) };
  }

  private row(projectId: string, path: string): Row | null {
    return this.db.prepare('SELECT path,sha256,size,revision,owner_run_id,updated_at FROM research_workspace_files WHERE project_id = ? AND path = ?')
      .get(projectId, path) as Row | undefined ?? null;
  }

  private requireEditable(path: string): void {
    const relative = researchRelativePath(path);
    if (relative.split('/').some((part) => blocked.has(part) || part.startsWith('.'))) throw new Error('research_workspace_file_not_editable');
    if (!editable.has(extname(relative).toLowerCase())) throw new Error('research_workspace_file_not_editable');
  }
}
