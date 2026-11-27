import {lstat, rm, unlink} from 'node:fs/promises';
import {join, posix} from 'node:path';
import type {WorkspacePathStructureChangeNotifier} from '../../services/workspace-path-structure-event';
import type {ResearchDocumentService} from './document-service';
import {documentStorageRoot, maximumDocumentBytes} from './document-files';
import type {LiteratureAcquisitionService} from './literature-acquisition-service';
import type {LibraryCleanup, LibraryDeletionRepository} from './library-deletion-repository';
import {researchContentHash, researchPath, researchWorkspace} from './research-files';
import {verifyDocumentSource} from './verified-document-source';

type Result = {cleanupPending: boolean; preservedFiles: number};
type Pdf = LibraryCleanup['pdfs'][number];

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const singleComponent = (value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('research_library_cleanup_path_invalid');
  return value;
};

async function removeDirectory(root: string, relative: string): Promise<void> {
  try {await rm(await researchPath(root, relative), {recursive: true, force: true});}
  catch (error) {if (!missing(error)) throw error;}
}

/** SQLite removal and filesystem cleanup have separate commit points. The manifest
 * is durable before any unlink and never contains imported article text. */
export class LibraryDeletionService {
  private readonly active = new Map<string, Promise<Result>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private getDocuments: (() => ResearchDocumentService | null) | undefined;

  constructor(private readonly repository: LibraryDeletionRepository, private readonly acquisition: LiteratureAcquisitionService,
    private readonly roots: {library: string | null; index?: string; resource: string},
    private readonly onDeleted: (item: {id: string; projectIds: string[]}) => void,
    private readonly notifyWorkspace: WorkspacePathStructureChangeNotifier,
    private readonly releaseKnowledge: (documentIds: string[]) => Promise<void>,
    private readonly withIndexReleased: (projectId: string, action: () => Promise<void>) => Promise<void>,
    private readonly cleanVisualIndex: (projectId: string, documentIds: string[]) => Promise<void>,
    private readonly onCleanupFailure: (itemId: string) => void) {}

  setDocumentService(getDocuments: () => ResearchDocumentService | null): void {
    this.getDocuments = getDocuments;
  }

  start(): void {
    this.retryPending();
    this.timer = setInterval(() => this.retryPending(), 30_000);
    this.timer.unref();
  }

  async delete(id: string, expectedRevision: number): Promise<Result> {
    if (this.closed) throw new Error('research_library_cleanup_closed');
    const running = this.active.get(id);
    if (running) return await running;
    const pending = this.repository.pending(id);
    const cleanup = pending ?? this.repository.begin(id, expectedRevision);
    if (cleanup === null) return {cleanupPending: false, preservedFiles: 0};
    if (pending === null) this.onDeleted({id, projectIds: cleanup.projectIds});
    return await this.run(id, cleanup);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.active.values());
  }

  private retryPending(): void {
    if (this.closed) return;
    for (const id of this.repository.pendingIds()) {
      if (this.active.has(id)) continue;
      try {
        const cleanup = this.repository.pending(id);
        if (cleanup) void this.run(id, cleanup);
      } catch { this.onCleanupFailure(id); }
    }
  }

  private run(id: string, cleanup: LibraryCleanup): Promise<Result> {
    const job = this.cleanup(id, cleanup).finally(() => this.active.delete(id));
    this.active.set(id, job);
    return job;
  }

  private async cleanup(id: string, cleanup: LibraryCleanup): Promise<Result> {
    const preserved = new Set<string>();
    const removed = new Set<string>();
    let failed = false;
    const attempt = async (action: () => Promise<void>): Promise<void> => {
      try {await action();}
      catch {failed = true;}
    };
    try {
      // Removing the SQLite rows fences late publications. Then wait for workers
      // that might still hold open files or have an in-flight hard link.
      await Promise.all([this.acquisition.releaseItem(id), this.releaseKnowledge(cleanup.knowledgeIds),
        this.getDocuments?.()?.releaseItem(id, cleanup.documentIds)]);
      if (cleanup.documentIds.length || cleanup.parseScopes.length) {
        await attempt(async () => {
          const root = await documentStorageRoot(this.roots.library);
          for (const documentId of cleanup.documentIds) await removeDirectory(root, `documents/${singleComponent(documentId)}`);
          for (const scope of cleanup.parseScopes) await removeDirectory(root, `paper-ir/${singleComponent(scope)}`);
        });
      }
      if (cleanup.jobIds.length) {
        await attempt(async () => {
          const root = await researchWorkspace(this.roots.resource).catch(error => {if (!missing(error)) throw error; return null;});
          if (root !== null) for (const jobId of cleanup.jobIds) {
            await removeDirectory(root, `literature-pdf/${researchContentHash(jobId)}`);
          }
        });
      }
      for (const file of cleanup.pdfs) {
        await attempt(async () => {
          const key = JSON.stringify([file.workspacePath, file.relativePath]);
          const remove = async (): Promise<void> => {
            const result = await this.removePdf(id, file, async root => {
              if (file.workspacePath === null) return;
              this.repository.purgeWorkspaceIndex(id, root, file.relativePath, file.sha256);
              this.notifyWorkspace(root, 'literature-pdf-deleted');
            });
            if (result === 'preserved') preserved.add(key);
            if (result === 'removed') removed.add(key);
          };
          const projects = file.workspacePath === null ? [] : this.repository.workspaceIndexProjects(file.workspacePath);
          await projects.reduceRight<() => Promise<void>>((next, project) => () => this.withIndexReleased(project, next), remove)();
        });
      }
      const latest = this.repository.pending(id) ?? cleanup;
      const indexRoot = this.roots.index;
      if (latest.indexPaths.length && indexRoot !== undefined) {
        await attempt(async () => {
          const root = await documentStorageRoot(indexRoot);
          for (const path of latest.indexPaths) {
            if (this.repository.isIndexPathShared(path)) continue;
            if (/^(?:artifacts|paper-ir)\/[a-f0-9]{64}$/u.test(path)) await removeDirectory(root, path);
            else if (/^sources\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\/source\.pdf$/u.test(path)) {
              try {await unlink(await researchPath(root, path));}
              catch (error) {if (!missing(error)) throw error;}
            } else throw new Error('research_library_cleanup_path_invalid');
          }
        });
      }
      const visualDocuments = [...latest.documentIds, ...latest.indexDocumentIds];
      for (const projectId of latest.projectIds) {
        if (visualDocuments.length) await attempt(() => this.cleanVisualIndex(projectId, visualDocuments));
      }
      if (!failed) this.repository.finish(id);
    } catch {failed = true;}
    if (failed) this.onCleanupFailure(id);
    return {cleanupPending: failed, preservedFiles: [...preserved].filter(key => !removed.has(key)).length};
  }

  private async removePdf(id: string, file: Pdf, afterRemoval: (root: string) => Promise<void>): Promise<'removed' | 'preserved' | 'missing'> {
    const itemSuffix = researchContentHash(id).slice(0, 12);
    const filename = posix.basename(file.relativePath);
    if (!/^papers\/(?:[0-9]{4}|undated)$/u.test(posix.dirname(file.relativePath)) ||
        !filename.match(new RegExp(`^[a-z0-9-]+--${itemSuffix}(?:--[a-f0-9]{16})?\\.pdf$`, 'u'))) {
      throw new Error('research_library_cleanup_path_invalid');
    }
    const workspace = file.workspacePath ?? join(this.roots.resource, 'literature-pdf-library');
    const root = await researchWorkspace(workspace).catch(error => {
      if (file.workspacePath !== null || !missing(error)) throw error;
      return null;
    });
    if (root === null) return 'missing';
    if (file.inode !== undefined && root !== workspace) return 'preserved';
    if (file.temporaryPath !== undefined) {
      if (posix.dirname(file.temporaryPath) !== posix.dirname(file.relativePath) ||
          !/^\.roc-[a-f0-9-]{36}\.part$/u.test(posix.basename(file.temporaryPath))) {
        throw new Error('research_library_cleanup_path_invalid');
      }
      await this.unlinkPdf(root, file.temporaryPath, file, false);
    }
    const result = await this.unlinkPdf(root, file.relativePath, file, true);
    if (result !== 'preserved') await afterRemoval(root);
    return result;
  }

  private async unlinkPdf(root: string, path: string, file: Pdf, verifyBytes: boolean): Promise<'removed' | 'preserved' | 'missing'> {
    try {
      const absolute = await researchPath(root, path);
      const info = await lstat(absolute, {bigint: true});
      if (!info.isFile() || (file.inode !== undefined && (String(info.ino) !== file.inode || String(info.dev) !== file.device))) {
        return 'preserved';
      }
      if (verifyBytes) {
        if (file.bytes > maximumDocumentBytes || info.size !== BigInt(file.bytes)) return 'preserved';
        try {await verifyDocumentSource(root, path, file.bytes, file.sha256);}
        catch (error) {
          if (error instanceof Error && error.message === 'research_document_source_changed') return 'preserved';
          throw error;
        }
      }
      if (await researchPath(root, path) !== absolute) return 'preserved';
      const current = await lstat(absolute, {bigint: true});
      if (current.ino !== info.ino || current.dev !== info.dev || current.mtimeNs !== info.mtimeNs || current.size !== info.size) return 'preserved';
      await unlink(absolute);
      return 'removed';
    } catch (error) {
      if (missing(error)) return 'missing';
      if (error instanceof Error && error.message === 'research_path_symlink') return 'preserved';
      throw error;
    }
  }
}
