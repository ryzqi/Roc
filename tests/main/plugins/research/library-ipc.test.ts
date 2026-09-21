import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { researchKnowledgeSearchResultSchema, researchProjectSchema } from '../../../../src/shared/schemas/research';
import { researchLibraryExportSchema, researchLibraryImportResultSchema, researchLibraryItemSchema } from '../../../../src/shared/schemas/research-library';
import { libraryEntry } from './library-fixtures';

let db: Database.Database;
let root: string;
let plugin: ReturnType<typeof createResearchPlugin>;
let adapter: ReturnType<typeof createPluginCapabilityAdapter>;
let capabilityError: unknown;
const toolchainRoot = process.env.ROC_RESEARCH_TOOLCHAIN;
const artifacts = process.env.ROC_RESEARCH_ARTIFACT_ROOT;

beforeEach(async () => {
  if (artifacts !== undefined) {
    if (!isAbsolute(artifacts)) throw new Error('research_artifact_root_must_be_absolute');
    await mkdir(artifacts, { recursive: true });
  }
  root = await realpath(await mkdtemp(join(artifacts ?? tmpdir(), 'roc library integration-')));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  plugin = createResearchPlugin({ toolchainRoot, libraryRoot: join(root, 'library'), libraryFetch: process.env.ROC_RESEARCH_LIVE_DOI === '1' ? undefined : async () => Response.json({
    type: 'journal-article', DOI: '10.1234/paper', title: '研究 DNA study', author: [{ family: 'Doe', given: 'Jane' }],
    issued: { 'date-parts': [[2009, 1]] }, abstract: 'Measured evidence from DOI metadata.', 'custom-extra': 'preserved',
    ISSN: ['1745-2473', '1745-2481']
  }) });
  const capabilities = new CapabilityRegistry();
  for (const capability of plugin.manifest.capabilities) capabilities.declare(plugin.manifest.id, capability);
  await plugin.initialize({
    pluginId: plugin.manifest.id, capabilities, database: { getConnection: () => db },
    eventBus: { publish: async () => {}, subscribe: () => () => {} }, config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  adapter = createPluginCapabilityAdapter({ invokeCapability: async <TInput, TOutput>(name: string, input: TInput) => {
    try { return await capabilities.invoke<TInput, TOutput>(name, input); }
    catch (error) { capabilityError = error; throw error; }
  } });
});
afterEach(async () => {
  await plugin.shutdown();
  db.close();
  if (artifacts === undefined) await rm(root, { recursive: true, force: true });
});

async function call<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
  capabilityError = undefined;
  const response = await adapter.invoke(`research.${method}`, [input]);
  if (!response.ok) throw new Error(`${method}: ${response.error.message}`, { cause: capabilityError });
  return schema.parse(response.data);
}

describe('research library IPC', () => {
  it('routes list, get, project links, archive and versioned citation editing through validated contracts', async () => {
    const project = await call('createProject', { title: 'Library IPC', description: 'Library contract integration.', workspacePath: '/tmp/library-ipc.test-1' }, researchProjectSchema);
    const item = new ResearchRepository(db).library.import([libraryEntry()], null).items[0];
    const query = { projectId: null, query: '', includeArchived: false, limit: 100 };
    expect(await call('listLibrary', query, researchLibraryItemSchema.array())).toEqual([item]);
    expect(await call('getLibraryItem', { id: item.id }, researchLibraryItemSchema)).toEqual(item);
    expect(await call('linkLibraryItem', { id: item.id, projectId: project.id, linked: true }, researchLibraryItemSchema)).toMatchObject({ projectIds: [project.id] });
    const edited = await call('setLibraryCitationKey', { id: item.id, expectedRevision: item.revision, citationKey: 'edited' }, researchLibraryItemSchema);
    expect(edited.bibliography.citationKey).toBe('edited');
    expect(await adapter.invoke('research.setLibraryCitationKey', [{ id: item.id, expectedRevision: item.revision, citationKey: 'stale' }]))
      .toMatchObject({ ok: false, error: { code: 'research_library_version_conflict', category: 'conflict' } });
    await call('archiveLibraryItem', { id: item.id, expectedRevision: edited.revision, archived: true }, researchLibraryItemSchema);
    expect(await call('listLibrary', query, researchLibraryItemSchema.array())).toEqual([]);
    expect(await call('listLibrary', { ...query, includeArchived: true }, researchLibraryItemSchema.array())).toHaveLength(1);
    expect((await adapter.invoke('research.importBibliography', [{ sourcePath: '/not-used', format: 'unknown', projectId: null }])).ok).toBe(false);
    expect((await adapter.invoke('research.importLibraryRecord', [{ record: libraryEntry().metadata, projectId: null }])).ok).toBe(false);
    expect((await adapter.invoke('research.listLibrary', [{ query: '' }])).ok).toBe(false);
  });

  it.skipIf(toolchainRoot === undefined)('round trips real bibliography files and search/DOI records through IPC and private Python', async () => {
    const project = await call('createProject', { title: 'Round trip', description: 'Bibliography round trip.', workspacePath: root }, researchProjectSchema);
    const source = join(root, 'references.bib');
    await writeFile(source, '@article{original,title={研究 {DNA} study},author={Doe, Jane and {Research Group}},date={2026-09-11},doi={10.1234/PAPER},journaltitle={Journal},custom={keep me},url={https://example.org/a%20b}}');
    const imported = await call('importBibliography', { sourcePath: source, format: 'biblatex', projectId: project.id }, researchLibraryImportResultSchema);
    expect(imported).toMatchObject({ createdCount: 1, duplicateCount: 0 });
    const item = imported.items[0];
    expect(item.metadata).toMatchObject({ title: '研究 DNA study', doi: '10.1234/paper', authors: ['Jane Doe', 'Research Group'] });
    const doi = await call('importLibraryDoi', { doi: '10.1234/paper', projectId: project.id }, researchLibraryImportResultSchema);
    expect(doi).toMatchObject({ createdCount: 0, duplicateCount: 1 });
    expect(doi.items[0].id).toBe(item.id);
    expect(doi.items[0].metadata.publishedYear).toBe(2026);
    const search = await call('importLibraryRecord', { record: libraryEntry({ doi: '10.1234/second', externalId: 'second', title: 'Second study', authors: ['Research and Development Group'] }).metadata,
      citationKey: 'original', projectId: project.id }, researchLibraryImportResultSchema);
    expect(search.items[0].metadata.authors).toEqual(['Research and Development Group']);
    const conflict = await adapter.invoke('research.exportBibliography', [{ ids: [item.id, search.items[0].id], format: 'bibtex' }]);
    expect(conflict).toMatchObject({ ok: false, error: { code: 'research_citation_key_duplicate', category: 'conflict' } });
    await call('setLibraryCitationKey', { id: search.items[0].id, expectedRevision: search.items[0].revision, citationKey: 'second' }, researchLibraryItemSchema);
    const exported = await call('exportBibliography', { ids: [item.id, search.items[0].id], format: 'csl-json' }, researchLibraryExportSchema);
    const json: unknown = JSON.parse(exported.content);
    expect(json).toMatchObject([{ id: 'original', type: 'article-journal', title: '研究 DNA study', issued: { 'date-parts': [[2026, 9, 11]] }, 'custom-extra': 'preserved' },
      { id: 'second', author: [{ literal: 'Research and Development Group' }] }]);
    const exportedPath = join(root, exported.filename);
    await writeFile(exportedPath, exported.content);
    const restored = await call('importBibliography', { sourcePath: exportedPath, format: 'csl-json', projectId: null }, researchLibraryImportResultSchema);
    expect(restored).toMatchObject({ createdCount: 0, duplicateCount: 2 });
    const bib = await call('exportBibliography', { ids: [item.id], format: 'bibtex' }, researchLibraryExportSchema);
    expect(bib.content).toContain('custom = {keep me}');
    expect(bib.content).toContain('title = {研究 {DNA} study}');
    expect(bib.content).not.toContain('year = {2009}');
    expect(await readFile(source, 'utf8')).toContain('journaltitle={Journal}');
    const knowledge = await call('searchKnowledge', { query: 'Measured', projectId: project.id, limit: 10, embeddingConfigId: null }, researchKnowledgeSearchResultSchema);
    expect(knowledge.hits.some((hit) => hit.sourceId === item.id && hit.locator === 'abstract')).toBe(true);
    if (artifacts !== undefined) await writeFile(join(root, 'result.json'), JSON.stringify({ imported, doi, search, exported, restored, bib, knowledge }, null, 2));
  }, 180_000);

  it.skipIf(toolchainRoot === undefined || process.env.ROC_RESEARCH_LIVE_DOI !== '1')('imports a public DOI over the network and exports its actual metadata', async () => {
    const imported = await call('importLibraryDoi', { doi: '10.1038/nphys1170', projectId: null }, researchLibraryImportResultSchema);
    expect(imported.items[0].metadata).toMatchObject({ doi: '10.1038/nphys1170', title: 'Measured measurement', authors: ['Markus Aspelmeyer'], publishedYear: 2009 });
    expect(imported.items[0].bibliography.fields.issn).toBe('1745-2473, 1745-2481');
    const bib = await call('exportBibliography', { ids: [imported.items[0].id], format: 'bibtex' }, researchLibraryExportSchema);
    expect(bib.content).toContain('Measured measurement');
    expect(bib.content).toContain('10.1038/nphys1170');
    if (artifacts !== undefined) await writeFile(join(root, 'live-doi-result.json'), JSON.stringify({ imported, bib }, null, 2));
  }, 180_000);
});
