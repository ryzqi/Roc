import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { z } from 'zod';
import type { ResearchLiterature } from '../../../shared/types';
import type {
  researchLibraryDoiImportRequestSchema, researchLibraryFileImportRequestSchema, researchLibraryExportRequestSchema,
  researchLibraryRecordImportRequestSchema, researchLibraryImportResultSchema, researchLibraryExportSchema
} from '../../../shared/schemas/research-library';
import { readResearchFile, researchWorkspace } from './research-files';
import { bibliographyIdentity, normalizeResearchDoi, referenceKey } from './literature-identity';
import type { BibliographyEntry, ResearchLibraryRepository } from './library-repository';
import type { ResearchToolchain } from './toolchain';

type LibraryTools = Pick<ResearchToolchain, 'readBibliography' | 'normalizeBibliography' | 'writeBibliography'>;
type ImportResult = z.infer<typeof researchLibraryImportResultSchema>;
type LibraryFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ResearchLibraryService {
  private readonly active = new Set<{ controller: AbortController; promise: Promise<unknown> }>();
  private closed = false;

  constructor(private readonly repository: ResearchLibraryRepository, private readonly tools: LibraryTools,
    private readonly rootPath: string | null, private readonly fetchImpl: LibraryFetch = (url, init) => fetch(url, init)) {}

  async importFile(request: z.infer<typeof researchLibraryFileImportRequestSchema>): Promise<ImportResult> {
    this.repository.validateDestination(request.projectId);
    return await this.job(async (root, directory, signal) => {
      if (!isAbsolute(request.sourcePath)) throw new Error('research_absolute_path_required');
      const info = await lstat(request.sourcePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('research_bibliography_source_invalid');
      const content = await readResearchFile(await researchWorkspace(dirname(request.sourcePath)), basename(request.sourcePath), 16 * 1024 * 1024);
      const source = join(directory, request.format === 'csl-json' ? 'source.json' : 'source.bib');
      await writeFile(source, content, { flag: 'wx', mode: 0o600 });
      const entries = await this.tools.readBibliography({ projectRoot: root, sourcePath: source, outputDir: join(directory, 'parsed'), jobDir: directory, format: request.format, signal });
      this.requireActive(signal);
      return this.repository.import(entries.map((bibliography) => ({ metadata: localMetadata(bibliography), bibliography })), request.projectId);
    });
  }

  async importRecord(request: z.infer<typeof researchLibraryRecordImportRequestSchema>): Promise<ImportResult> {
    this.repository.validateDestination(request.projectId);
    return await this.job(async (root, directory, signal) => {
      const source = join(directory, 'metadata.json');
      await writeFile(source, JSON.stringify([{ metadata: request.record, citationKey: request.citationKey }]), { flag: 'wx', mode: 0o600 });
      const entries = await this.tools.normalizeBibliography({ projectRoot: root, sourcePath: source, outputDir: join(directory, 'normalized'), jobDir: directory, signal });
      if (entries.length !== 1) throw new Error('research_bibliography_response_count_invalid');
      this.requireActive(signal);
      const bibliography = entries[0];
      return this.repository.import([{ metadata: { ...request.record, title: bibliography.title, authors: bibliography.authors }, bibliography }], request.projectId);
    });
  }

  async importDoi(request: z.infer<typeof researchLibraryDoiImportRequestSchema>): Promise<ImportResult> {
    this.repository.validateDestination(request.projectId);
    const doi = normalizeResearchDoi(request.doi);
    return await this.job(async (root, directory, signal) => {
      const response = await this.fetchImpl(`https://doi.org/${encodeURIComponent(doi)}`, {
        headers: { accept: 'application/vnd.citationstyles.csl+json', 'user-agent': 'Roc-research/0.1' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      });
      if (!response.ok) throw new Error(`research_doi_http_${response.status}`);
      if (response.body === null) throw new Error('research_doi_response_invalid');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 4 * 1024 * 1024) throw new Error('research_doi_response_too_large');
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      let csl: unknown;
      try { csl = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (cause) { throw new Error('research_doi_response_invalid', { cause }); }
      if (typeof csl !== 'object' || csl === null || Array.isArray(csl) || !('DOI' in csl) || typeof csl.DOI !== 'string'
          || normalizeResearchDoi(csl.DOI) !== doi) throw new Error('research_doi_response_mismatch');
      const source = join(directory, 'doi.json');
      const type = 'type' in csl && typeof csl.type === 'string' ? doiCslTypes[csl.type] ?? csl.type : undefined;
      const normalized: Record<string, unknown> = { ...csl, type, id: referenceKey(doi), 'citation-key': referenceKey(doi) };
      for (const field of ['ISSN', 'ISBN']) {
        const value = normalized[field];
        if (Array.isArray(value)) {
          if (value.length === 0 || !value.every((entry: unknown) => typeof entry === 'string' && entry.trim())) throw new Error('research_doi_response_invalid');
          normalized[field] = value.join(', ');
        }
      }
      await writeFile(source, JSON.stringify([normalized]), { flag: 'wx', mode: 0o600 });
      const entries = await this.tools.readBibliography({ projectRoot: root, sourcePath: source, outputDir: join(directory, 'parsed'), jobDir: directory, format: 'csl-json', signal });
      if (entries.length !== 1) throw new Error('research_bibliography_response_count_invalid');
      this.requireActive(signal);
      const bibliography = entries[0];
      const metadata = { ...localMetadata(bibliography), id: `doi:${doi}`, source: 'doi' as const, externalId: doi,
        url: bibliography.url ?? `https://doi.org/${doi}` };
      return this.repository.import([{ metadata, bibliography }], request.projectId);
    });
  }

  async export(request: z.infer<typeof researchLibraryExportRequestSchema>): Promise<z.infer<typeof researchLibraryExportSchema>> {
    if (new Set(request.ids).size !== request.ids.length) throw new Error('research_library_selection_duplicate');
    const items = request.ids.map((id) => this.repository.get(id));
    if (items.some((item) => item.archived)) throw new Error('research_library_item_archived');
    return await this.job(async (root, directory, signal) => {
      const source = join(directory, 'entries.json');
      await writeFile(source, JSON.stringify(items.map((item) => item.bibliography)), { flag: 'wx', mode: 0o600 });
      const result = await this.tools.writeBibliography({ projectRoot: root, sourcePath: source, outputDir: join(directory, 'exported'), jobDir: directory,
        format: request.format, signal });
      this.requireActive(signal);
      return { format: request.format, ...result };
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const task of this.active) task.controller.abort();
    await Promise.allSettled([...this.active].map((task) => task.promise));
  }

  private async job<T>(operation: (root: string, directory: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('research_library_closed');
    const controller = new AbortController();
    const task: { controller: AbortController; promise: Promise<unknown> } = { controller, promise: Promise.resolve() };
    const execute = async (): Promise<T> => {
      if (this.rootPath === null || !isAbsolute(this.rootPath)) throw new Error('research_library_storage_unavailable');
      try {
        if ((await lstat(this.rootPath)).isSymbolicLink()) throw new Error('research_library_storage_symlink');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
      const root = await realpath(this.rootPath);
      const directory = await mkdtemp(join(root, '.bibliography-'));
      try { this.requireActive(controller.signal); return await operation(root, directory, controller.signal); }
      finally { await rm(directory, { recursive: true, force: true }); }
    };
    this.active.add(task);
    const pending = execute();
    task.promise = pending;
    try { return await pending; }
    finally { this.active.delete(task); }
  }

  private requireActive(signal: AbortSignal): void {
    if (signal.aborted || this.closed) throw new Error('research_library_cancelled');
  }
}

function localMetadata(entry: BibliographyEntry): ResearchLiterature {
  const externalId = bibliographyIdentity(entry);
  const now = new Date().toISOString();
  return { id: `local:${externalId}`, source: 'local', externalId, doi: entry.doi, title: entry.title, authors: entry.authors,
    abstract: entry.abstract, publishedYear: entry.publishedYear, citationCount: null, url: entry.url, openAccessUrl: null, importedAt: now, updatedAt: now };
}

const doiCslTypes: Readonly<Record<string, string>> = {
  'journal-article': 'article-journal', 'book-chapter': 'chapter', 'proceedings-article': 'paper-conference',
  'posted-content': 'article', dissertation: 'thesis', monograph: 'book', 'edited-book': 'book',
  'reference-book': 'book', 'reference-entry': 'entry-encyclopedia', 'book-part': 'chapter',
  'report-component': 'report', 'report-series': 'report', 'book-series': 'book', journal: 'periodical'
};
