import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { ResearchTemplateService } from '../../../../src/main/plugins/research/template-service';
import type { LatexCommandRunner } from '../../../../src/main/plugins/research/latex-service';
import { ResearchProcessError } from '../../../../src/main/plugins/research/process-runner';

let db: Database.Database;
let repository: ResearchRepository;
let root: string;
let source: string;
let projectId: string;
const services: ResearchTemplateService[] = [];
let runner: LatexCommandRunner;

function service(): ResearchTemplateService {
  const value = new ResearchTemplateService(repository, { compile: (input) => runner(input), extractTemplate: async () => { throw new Error('zip_not_used_in_fixture'); } });
  services.push(value);
  return value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-template-service-')));
  source = join(root, 'input');
  await mkdir(source);
  await writeFile(join(source, 'main.tex'), '\\documentclass{article}\nOriginal text.');
  await writeFile(join(source, 'references.bib'), '@article{sample,title={Sample}}');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Templates', description: 'Template integration', workspacePath: root }).id;
  runner = async ({ rootPath, outputDir }) => {
    await writeFile(join(outputDir, 'main.pdf'), `%PDF-1.7\n${await readFile(join(rootPath, 'main.tex'), 'utf8')}`);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((value) => value.shutdown()));
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe('research templates', () => {
  it('preserves template resources independently from editable extensions', async () => {
    await writeFile(join(source, 'main.tex'), '\\documentclass{article}\n\\input{diagram.tikz}');
    await writeFile(join(source, 'diagram.tikz'), 'A diagram');
    await writeFile(join(source, 'data.csv'), 'group,value\ncontrol,12');
    await writeFile(join(source, 'custom.fontdata'), Buffer.from([0, 1, 2]));
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const files = await templates.files({ projectId, templateId: template.id });
    expect(files.map((file) => file.path)).toEqual(['custom.fontdata', 'data.csv', 'diagram.tikz', 'main.tex', 'references.bib']);
    expect(files.find((file) => file.path === 'custom.fontdata')?.editable).toBe(false);
    expect(await readFile(join(template.rootPath, 'custom.fontdata'))).toEqual(Buffer.from([0, 1, 2]));
  });

  it('restores original content and revokes new files when database persistence fails', async () => {
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const request = { projectId, templateId: template.id };
    const ready = await templates.compile(request);
    const original = await templates.readFile({ ...request, path: 'main.tex' });
    db.exec("CREATE TRIGGER reject_template_save BEFORE UPDATE ON research_templates BEGIN SELECT RAISE(ABORT, 'save_failed'); END");
    await expect(templates.saveFile({ ...request, path: 'main.tex', expectedHash: original.sha256, content: 'New contents' })).rejects.toThrow('save_failed');
    expect(await templates.readFile({ ...request, path: 'main.tex' })).toEqual(original);
    expect(templates.get(request)).toEqual(ready);
    await expect(templates.saveFile({ ...request, path: 'new.tex', expectedHash: null, content: 'New file' })).rejects.toThrow('save_failed');
    await expect(readFile(join(template.rootPath, 'new.tex'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(templates.get(request)).toEqual(ready);
  });

  it('does not overwrite a later external edit while rolling back a rejected save', async () => {
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const request = { projectId, templateId: template.id };
    const original = await templates.readFile({ ...request, path: 'main.tex' });
    const spy = vi.spyOn(repository, 'saveTemplate').mockImplementationOnce(() => {
      writeFileSync(join(template.rootPath, 'main.tex'), 'External editor content');
      throw new Error('save_failed');
    });
    try {
      await expect(templates.saveFile({ ...request, path: 'main.tex', expectedHash: original.sha256, content: 'App content' })).rejects.toThrow('save_failed');
      expect((await templates.readFile({ ...request, path: 'main.tex' })).content).toBe('External editor content');
      await templates.files(request);
      expect(templates.get(request)).toMatchObject({ revision: 2, status: 'imported' });
    } finally { spy.mockRestore(); }
  });

  it('keeps the existing compiler alive when a concurrent edit cannot be committed', async () => {
    const entered = deferred();
    const release = deferred();
    let signal: AbortSignal | undefined;
    const originalRunner = runner;
    runner = async (input) => { signal = input.signal; entered.resolve(); await release.promise; return await originalRunner(input); };
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const request = { projectId, templateId: template.id };
    const originalFile = await templates.readFile({ ...request, path: 'main.tex' });
    const pending = templates.compile(request);
    await entered.promise;
    db.exec("CREATE TRIGGER reject_concurrent_save BEFORE UPDATE ON research_templates WHEN NEW.status = 'imported' BEGIN SELECT RAISE(ABORT, 'save_failed'); END");
    try {
      await expect(templates.saveFile({ ...request, path: 'main.tex', content: 'Rejected contents', expectedHash: originalFile.sha256 })).rejects.toThrow('save_failed');
      expect(await templates.readFile({ ...request, path: 'main.tex' })).toEqual(originalFile);
      expect(signal?.aborted).toBe(false);
      release.resolve();
      await expect(pending).resolves.toMatchObject({ status: 'ready', revision: 1, compiledRevision: 1, activeCompileId: null });
      await templates.shutdown();
      expect(templates.get(request).activeCompileId).toBe(null);
    } finally { release.resolve(); await pending; }
  });

  it('imports, edits with optimistic hashes, compiles a snapshot and verifies PDF preview', async () => {
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const request = { projectId, templateId: template.id };
    expect(templates.list(projectId)).toHaveLength(1);
    expect(await templates.files(request)).toHaveLength(2);
    const file = await templates.readFile({ ...request, path: 'main.tex' });
    const saved = await templates.saveFile({ ...request, path: file.path, content: '\\documentclass{article}\nEdited text.', expectedHash: file.sha256 });
    expect(saved.sha256).not.toBe(file.sha256);
    await expect(templates.saveFile({ ...request, path: file.path, content: 'Old write', expectedHash: file.sha256 })).rejects.toThrow('research_template_file_conflict');
    expect(await readFile(join(source, 'main.tex'), 'utf8')).toContain('Original text.');
    const compiled = await templates.compile(request);
    expect(compiled).toMatchObject({ status: 'ready', revision: 2, compiledRevision: 2, activeCompileId: null, compiledDigest: compiled.sourceDigest });
    if (compiled.pdfHash === null) throw new Error('pdf_hash_missing');
    expect((await templates.pdf({ ...request, pdfHash: compiled.pdfHash })).toString()).toContain('Edited text.');
    await expect(templates.pdf({ ...request, pdfHash: 'f'.repeat(64) })).rejects.toThrow('research_template_preview_stale');
    expect(repository.listWorkflowEvents({ projectId, limit: 100 }).some((event) => event.type === 'template_compile_ready')).toBe(true);
  });

  it('does not publish a late compiler result after an edit', async () => {
    const entered = deferred();
    const release = deferred();
    let signal: AbortSignal | undefined;
    const original = runner;
    runner = async (input) => { signal = input.signal; entered.resolve(); await release.promise; return await original(input); };
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const request = { projectId, templateId: template.id };
    const file = await templates.readFile({ ...request, path: 'main.tex' });
    const pending = templates.compile(request);
    await entered.promise;
    await templates.saveFile({ ...request, path: 'main.tex', content: '\\documentclass{article}\nNew text.', expectedHash: file.sha256 });
    expect(signal?.aborted).toBe(true);
    release.resolve();
    await expect(pending).resolves.toMatchObject({ status: 'imported', revision: 2, pdfPath: null, activeCompileId: null });
  });

  it('keeps the newest compile when an older cancelled invocation returns last', async () => {
    const entered = deferred();
    const release = deferred();
    const original = runner;
    let calls = 0;
    runner = async (input) => { if (++calls === 1) { entered.resolve(); await release.promise; } return await original(input); };
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const request = { projectId, templateId: template.id };
    const old = templates.compile(request);
    await entered.promise;
    const newest = await templates.compile(request);
    release.resolve();
    await expect(old).resolves.toMatchObject({ pdfPath: newest.pdfPath, pdfHash: newest.pdfHash, status: 'ready' });
    expect(templates.get(request).pdfPath).toBe(newest.pdfPath);
  });

  it('invalidates a result when files change outside the editor during compile', async () => {
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const original = runner;
    runner = async (input) => { await writeFile(join(template.rootPath, 'main.tex'), '\\documentclass{article}\nExternal edit.'); return await original(input); };
    await expect(templates.compile({ projectId, templateId: template.id })).resolves.toMatchObject({ status: 'imported', revision: 2, pdfPath: null });
  });

  it('records timeout failure and preserves a previous PDF without claiming it is current', async () => {
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const request = { projectId, templateId: template.id };
    const ready = await templates.compile(request);
    runner = async () => { throw new ResearchProcessError('research_process_timeout'); };
    await expect(templates.compile(request)).resolves.toMatchObject({ status: 'failed', activeCompileId: null,
      pdfPath: ready.pdfPath, errors: ['research_process_timeout'] });
  });

  it('rejects cross-project access, symlink templates and managed-directory redirects', async () => {
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    const other = repository.createProject({ title: 'Other', description: 'Another project', workspacePath: root });
    await expect(templates.readFile({ projectId: other.id, templateId: template.id, path: 'main.tex' })).rejects.toThrow('research_template_not_found');
    await symlink(join(source, 'main.tex'), join(source, 'linked.tex'));
    await expect(templates.importTemplate({ projectId, sourcePath: source })).rejects.toThrow('research_template_symlink');
    expect(templates.list(projectId)).toHaveLength(1);
    await expect(templates.saveFile({ projectId, templateId: template.id, path: '../../outside.tex', expectedHash: null, content: 'bad' })).rejects.toThrow();
    expect(await readFile(join(source, 'main.tex'), 'utf8')).toContain('Original text.');
  });

  it('rolls back a failed import audit and removes its owned file copy', async () => {
    db.exec("CREATE TRIGGER reject_template_event BEFORE INSERT ON research_workflow_events WHEN NEW.type = 'template_imported' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    const templates = service();
    await expect(templates.importTemplate({ projectId, sourcePath: source })).rejects.toThrow('audit failed');
    expect(templates.list(projectId)).toHaveLength(0);
    expect(await readdir(join(root, '.roc-research/templates'))).toEqual([]);
  });

  it('recovers an interrupted compile and requires the current revision when changing entry', async () => {
    const templates = service();
    const template = await templates.importTemplate({ projectId, sourcePath: source });
    repository.saveTemplate({ ...template, status: 'compiling', activeCompileId: 'interrupted' }, 1);
    repository.recoverTemplateCompiles();
    expect(templates.get({ projectId, templateId: template.id })).toMatchObject({ status: 'failed', activeCompileId: null, errors: ['research_compile_interrupted'] });
    await expect(templates.setEntry({ projectId, templateId: template.id, entryPath: 'main.tex', expectedRevision: 2 })).rejects.toThrow('research_template_version_conflict');
  });
});
