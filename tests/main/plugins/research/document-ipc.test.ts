import Database from 'better-sqlite3';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { researchKnowledgeSearchResultSchema, researchProjectSchema, researchTemplateSchema } from '../../../../src/shared/schemas/research';
import { researchDocumentParseSchema, researchDocumentRunSchema, researchDocumentSchema } from '../../../../src/shared/schemas/research-documents';
import { researchEvidenceSchema } from '../../../../src/shared/schemas/research-evidence';
import { researchDocumentAssetUrl, researchDocumentSourceUrl } from '../../../../src/shared/research-preview';
import { libraryEntry } from './library-fixtures';

let db: Database.Database;
let root: string;
let plugin: ReturnType<typeof createResearchPlugin>;
let capabilities: CapabilityRegistry;
let adapter: ReturnType<typeof createPluginCapabilityAdapter>;
let capabilityError: unknown;
const toolchainRoot = process.env.ROC_RESEARCH_TOOLCHAIN;
const artifacts = process.env.ROC_RESEARCH_ARTIFACT_ROOT;

beforeEach(async () => {
  if (artifacts !== undefined) {
    if (!isAbsolute(artifacts)) throw new Error('research_artifact_root_must_be_absolute');
    await mkdir(artifacts, { recursive: true });
  }
  root = await realpath(await mkdtemp(join(artifacts ?? tmpdir(), 'roc document integration-')));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  plugin = createResearchPlugin({ toolchainRoot, libraryRoot: join(root, 'library') });
  capabilities = new CapabilityRegistry();
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
  const result = await adapter.invoke(`research.${method}`, [input]);
  if (!result.ok) throw new Error(`${method}: ${result.error.message}`, { cause: capabilityError });
  return schema.parse(result.data);
}

describe('research document IPC', () => {
  it.skipIf(toolchainRoot !== undefined)('persists an attachment and exposes a recoverable unavailable-runtime state', async () => {
    const item = new ResearchRepository(db).library.import([libraryEntry()], null).items[0];
    const sourcePath = join(root, 'article.html');
    const html = '<h1>Original HTML</h1><script>window.example = true;</script>';
    await writeFile(sourcePath, html);
    const imported = await call('importDocument', { target: 'library-item', libraryItemId: item.id, sourcePath, projectId: null }, researchDocumentSchema);
    expect(await call('listDocuments', { libraryItemId: item.id }, researchDocumentSchema.array())).toEqual([imported]);
    expect(await call('getDocument', { documentId: imported.id }, researchDocumentSchema)).toEqual(imported);
    const source = await capabilities.invoke<unknown, Response>('research.document.source', { documentId: imported.id, sourceHash: imported.sourceHash });
    expect(source.headers.get('content-type')).toBe('application/octet-stream');
    expect(source.headers.get('content-disposition')).toContain('attachment');
    expect(source.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await source.text()).toBe(html);
    const failed = await call('parseDocument', { documentId: imported.id }, researchDocumentSchema);
    expect(failed).toMatchObject({ status: 'failed', activeParseId: null, currentParseId: null, error: 'research_toolchain_unavailable' });
    const runs = await call('listDocumentParses', { documentId: imported.id }, researchDocumentRunSchema.array());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'research_toolchain_unavailable' });
    expect((await adapter.invoke('research.getDocumentContent', [{ documentId: imported.id, parseId: runs[0].id }])).ok).toBe(false);
    expect((await adapter.invoke('research.cancelDocumentParse', [{ documentId: imported.id, parseId: runs[0].id }]))).toMatchObject({ ok: false, error: { code: 'research_document_parse_stale' } });
    expect((await adapter.invoke('research.importDocument', [{ target: 'new-item', sourcePath, projectId: null }])).ok).toBe(false);
  });

  it.skipIf(toolchainRoot === undefined)('imports and parses actual HTML and PDF, then serves located content and verified page images', async () => {
    const project = await call('createProject', { title: 'Full text', description: 'Actual document integration.', workspacePath: root }, researchProjectSchema);
    const htmlPath = join(root, 'article.html');
    await writeFile(htmlPath, '<html><body><h1>Research note</h1><p>Reference signal measured at 42 units.</p><table><tr><th>Group</th><th>Value</th></tr><tr><td>Control</td><td>42</td></tr></table></body></html>');
    const html = await call('importDocument', { target: 'new-item', sourcePath: htmlPath, title: 'Research note', citationKey: 'note2026', projectId: project.id }, researchDocumentSchema);
    const parsedHtml = await call('parseDocument', { documentId: html.id }, researchDocumentSchema);
    expect(parsedHtml).toMatchObject({ status: 'ready', error: null });
    if (parsedHtml.currentParseId === null) throw new Error('parse_id_required');
    const htmlContent = await call('getDocumentContent', { documentId: html.id, parseId: parsedHtml.currentParseId }, researchDocumentParseSchema);
    expect(htmlContent.content.content).toContain('Reference signal measured at 42 units.');
    expect(htmlContent.content.blocks.every((block) => block.locator.length > 0)).toBe(true);
    const search = await call('searchKnowledge', { query: 'Reference signal', projectId: project.id, limit: 10, embeddingConfigId: null }, researchKnowledgeSearchResultSchema);
    const hit = search.hits.find((entry) => entry.content.includes('42 units'));
    if (hit === undefined) throw new Error('expected_document_search_hit');
    const evidence = await call('captureEvidence', { projectId: project.id, chunkId: hit.chunkId }, researchEvidenceSchema);
    expect(evidence.excerpt).toContain('42 units');

    const templateRoot = join(root, 'template');
    await mkdir(templateRoot);
    await writeFile(join(templateRoot, 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nReference signal measured at 42 units.\\par\nA reproducible observation with a clear source.\n\\end{document}\n');
    const template = await call('importTemplate', { projectId: project.id, sourcePath: templateRoot }, researchTemplateSchema);
    const compiled = await call('compileTemplate', { projectId: project.id, templateId: template.id }, researchTemplateSchema);
    expect(compiled).toMatchObject({ status: 'ready', errors: [] });
    if (compiled.pdfPath === null) throw new Error('compiled_pdf_required');
    const pdf = await call('importDocument', { target: 'new-item', sourcePath: compiled.pdfPath, title: 'PDF observation', citationKey: 'pdf2026', projectId: project.id }, researchDocumentSchema);
    const parsedPdf = await call('parseDocument', { documentId: pdf.id }, researchDocumentSchema);
    expect(parsedPdf).toMatchObject({ status: 'ready', error: null });
    if (parsedPdf.currentParseId === null) throw new Error('parse_id_required');
    const pdfContent = await call('getDocumentContent', { documentId: pdf.id, parseId: parsedPdf.currentParseId }, researchDocumentParseSchema);
    expect(pdfContent.content).toMatchObject({ pageCount: 1, sourceHash: pdf.sourceHash });
    expect(pdfContent.content.content).toContain('42');
    expect(pdfContent.content.blocks.some((block) => block.locations.some((location) => location.page === 1))).toBe(true);
    const page = pdfContent.content.assets.find((asset) => asset.kind === 'page');
    if (page === undefined) throw new Error('page_image_required');
    const image = await capabilities.invoke<unknown, Response>('research.document.asset', { documentId: pdf.id, parseId: parsedPdf.currentParseId, assetId: page.id, sha256: page.sha256 });
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await rm(compiled.pdfPath);
    const source = await capabilities.invoke<unknown, Response>('research.document.source', { documentId: pdf.id, sourceHash: pdf.sourceHash });
    expect(Buffer.from(await source.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    expect(researchDocumentSourceUrl(pdf)).toContain(pdf.sourceHash);
    expect(researchDocumentAssetUrl(pdf.id, parsedPdf.currentParseId, page)).toContain(page.sha256);
    if (artifacts !== undefined) await writeFile(join(root, 'result.json'), JSON.stringify({ html, parsedHtml, htmlContent, evidence, pdf, parsedPdf, pdfContent }, null, 2));
  }, 600_000);
});
