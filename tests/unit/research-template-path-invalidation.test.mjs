import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

let tempDir;
let ResearchTemplateService;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-research-template-paths-'));
  const outfile = join(tempDir, 'template-service.mjs');
  await esbuild.build({ entryPoints: ['src/main/plugins/research/template-service.ts'], outfile, bundle: true,
    format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' });
  ({ ResearchTemplateService } = await import(outfile));
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

test('template imports and atomic file saves invalidate paths, including same-path updates', async () => {
  const workspacePath = join(tempDir, 'project-workspace');
  const sourcePath = join(tempDir, 'template-source');
  mkdirSync(workspacePath);
  mkdirSync(sourcePath);
  writeFileSync(join(sourcePath, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}');

  let template = null;
  const repository = {
    getProject: (id) => ({ id, status: 'active', workspacePath }),
    createTemplate: (input) => {
      template = { ...input, status: 'imported', pdfPath: null, pdfHash: null, revision: 1, activeCompileId: null,
        compiledRevision: null, compiledDigest: null, errors: [], diagnostics: [], lastCompiledAt: null };
      return template;
    },
    getTemplate: () => template,
    saveTemplate: (next) => {
      template = next;
      return template;
    }
  };
  const changes = [];
  const service = new ResearchTemplateService(repository, {}, (path, reason) => changes.push({ path, reason }));

  const imported = await service.importTemplate({ projectId: 'project-1', sourcePath });
  const created = await service.saveFile({ projectId: 'project-1', templateId: imported.id, path: 'notes.md',
    content: 'first', expectedHash: null });
  await service.saveFile({ projectId: 'project-1', templateId: imported.id, path: 'notes.md',
    content: 'updated', expectedHash: created.sha256 });

  assert.deepEqual(changes, [
    { path: workspacePath, reason: 'research.template-imported' },
    { path: workspacePath, reason: 'research.template-import-finished' },
    { path: workspacePath, reason: 'research.template-file-created' },
    { path: workspacePath, reason: 'research.template-file.atomic-save' }
  ]);
});
