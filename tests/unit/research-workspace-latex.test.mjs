import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ResearchTemplateService } = await importTypeScriptModule('src/main/plugins/research/template-service.ts', { platform: 'node' });
const source = '\\documentclass{article}\n\\begin{document}\nSaved workspace text.\n\\end{document}\n';

async function fixture(t, compile) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'roc-workspace-latex-'));
  await writeFile(join(workspacePath, 'main.tex'), source);
  const project = { status: 'active', workspacePath };
  const service = new ResearchTemplateService({ getProject: () => project }, { compile });
  t.after(async () => { await service.shutdown(); await rm(workspacePath, { recursive: true, force: true }); });
  return { service, workspacePath, project, request: { projectId: 'project-1', requestId: randomUUID(), entryPath: 'main.tex' } };
}

async function noJobs(workspacePath) {
  assert.deepEqual(await readdir(join(workspacePath, '.roc-research/jobs')), []);
}

test('workspace compilation uses saved files, publishes a verified PDF and removes its job', async t => {
  let captured;
  const { service, workspacePath, request } = await fixture(t, async input => {
    captured = await readFile(join(input.rootPath, input.entryPath), 'utf8');
    await writeFile(join(input.outputDir, 'main.pdf'), '%PDF-1.7\nworkspace result');
    await writeFile(join(input.outputDir, 'main.log'), 'temporary diagnostics');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const changed = source.replace('Saved workspace text.', 'Edited and saved before compilation.');
  await writeFile(join(workspacePath, 'main.tex'), changed);
  const result = await service.compileWorkspace(request);
  assert.equal(captured, changed);
  assert.equal(result.status, 'ready');
  assert.equal(result.outputPath, `.roc-build/latex/${request.requestId}.pdf`);
  assert.equal((await service.workspacePdf({ projectId: request.projectId, outputPath: result.outputPath, pdfHash: result.pdfHash })).subarray(0, 5).toString(), '%PDF-');
  await assert.rejects(service.workspacePdf({ projectId: request.projectId, outputPath: 'main.tex', pdfHash: result.pdfHash }), /latex_workspace_output_invalid/);
  await noJobs(workspacePath);
  assert.deepEqual(await readdir(join(workspacePath, '.roc-build/latex')), [`${request.requestId}.pdf`]);
});

test('failed and cancelled compilation report actual outcomes and clean job snapshots', async t => {
  let entered;
  const running = new Promise(resolve => { entered = resolve; });
  let attempt = 0;
  const { service, workspacePath, request } = await fixture(t, async input => {
    if (attempt++ === 0) return { exitCode: 1, stdout: '', stderr: 'main.tex:3: Undefined control sequence' };
    entered();
    return await new Promise((_resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    });
  });
  const failed = await service.compileWorkspace(request);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.diagnostics[0], { severity: 'error', file: 'main.tex', line: 3, message: 'Undefined control sequence' });
  await noJobs(workspacePath);
  const pendingRequest = { ...request, requestId: randomUUID() };
  const pending = service.compileWorkspace(pendingRequest);
  await running;
  assert.equal(service.cancelWorkspace({ projectId: request.projectId, requestId: request.requestId }).requested, false);
  assert.equal(service.cancelWorkspace(pendingRequest).requested, true);
  const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.outputPath, null);
  assert.equal(service.cancelWorkspace(pendingRequest).requested, false);
  await noJobs(workspacePath);
});

test('workspace compilation refuses archived projects, traversal and linked files', async t => {
  const { service, workspacePath, project, request } = await fixture(t, () => assert.fail('compiler must not run'));
  project.status = 'archived';
  await assert.rejects(service.compileWorkspace(request), /research_project_archived/);
  project.status = 'active';
  await assert.rejects(service.compileWorkspace({ ...request, entryPath: '../outside.tex' }), /research_relative_path_invalid/);
  await symlink(join(workspacePath, 'main.tex'), join(workspacePath, 'linked.tex'));
  await assert.rejects(service.compileWorkspace({ ...request, entryPath: 'linked.tex' }), /research_path_symlink/);
});

test('current workspace compiles with the installed offline toolchain', { skip: !process.env.ROC_WORKSPACE_LATEX_TOOLCHAIN, timeout: 180_000 }, async t => {
  const { ResearchToolchain } = await importTypeScriptModule('src/main/plugins/research/toolchain.ts', { platform: 'node', tempDir: resolve('.runtime/tmp') });
  const tools = new ResearchToolchain(resolve(process.env.ROC_WORKSPACE_LATEX_TOOLCHAIN));
  const { service, workspacePath, request } = await fixture(t, input => tools.compile(input));
  const result = await service.compileWorkspace(request);
  assert.equal(result.status, 'ready', JSON.stringify(result.diagnostics));
  const bytes = await readFile(join(workspacePath, result.outputPath));
  assert.ok(bytes.length > 500);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  await noJobs(workspacePath);
});
