import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

let directory, pdf, text, app, page;
const errors = [];
const options = {title: 'Fallback title', citationKey: 'fallback2026', projectId: 'project'};
const documentResult = {
  ok: true,
  data: {
    id: 'document', libraryItemId: 'paper', filename: 'local-paper.PDF', mediaType: 'application/pdf',
    sourceHash: 'a'.repeat(64), size: 20, status: 'imported', currentParseId: null, activeParseId: null,
    error: null, createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z'
  }
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-pdf-drop-bridge-'));
  pdf = join(directory, 'local-paper.PDF');
  text = join(directory, 'other.txt');
  await Promise.all([
    writeFile(pdf, '%PDF-1.7\n%%EOF\n'),
    writeFile(text, 'not a PDF'),
    writeFile(join(directory, 'index.html'), '<!doctype html><input type="file" aria-label="Native file">')
  ]);
  const preload = join(directory, 'preload.cjs');
  const main = join(directory, 'main.cjs');
  await Promise.all([
    build({entryPoints: ['src/preload/index.ts'], outfile: preload, bundle: true,
      platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'silent'}),
    build({stdin: {contents: `
      import {app,BrowserWindow,ipcMain} from 'electron';
      import {ipcChannels} from './src/shared/ipc-generated';
      import {researchDocumentImportRequestSchema} from './src/shared/schemas/research-documents';
      app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
      globalThis.pdfDropRequests=[];globalThis.pdfDropReply=${JSON.stringify(documentResult)};
      ipcMain.handle(ipcChannels.researchDocumentImport,(_event,input)=>{
        const request=researchDocumentImportRequestSchema.parse(input);
        globalThis.pdfDropRequests.push(request);
        if(globalThis.pdfDropThrow) throw new Error(globalThis.pdfDropThrow);
        return globalThis.pdfDropReply;
      });
      app.whenReady().then(()=>new BrowserWindow({show:true,width:480,height:320,
        webPreferences:{preload:${JSON.stringify(preload)},sandbox:true,contextIsolation:true,nodeIntegration:false}})
        .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
    `, resolveDir: process.cwd(), sourcefile: 'pdf-drop-main.ts', loader: 'ts'},
    outfile: main, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    external: ['electron'], logLevel: 'silent'})
  ]);
  app = await _electron.launch({executablePath: electronPath, args: [main]});
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.rocPdfDrop?.importPdf === 'function');
});

after(async () => {
  try {
    await app?.close();
  } finally {
    if (directory) await rm(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

async function importNative(input = options) {
  await page.getByLabel('Native file').setInputFiles(pdf);
  return page.evaluate(input => window.rocPdfDrop.importPdf(document.querySelector('input').files[0], input), input);
}

async function requests() {
  return app.evaluate(() => globalThis.pdfDropRequests);
}

test('native disk-backed PDF crosses the isolated bridge without exposing native path capabilities', async () => {
  const result = await importNative({...options, metadataMode: 'automatic',
    sourcePath: '/injected/source.pdf', target: 'library-item', libraryItemId: 'injected'});
  assert.deepEqual(result, documentResult);
  assert.equal(JSON.stringify(result).includes(directory), false);
  assert.deepEqual(await requests(), [{target: 'new-item', sourcePath: pdf, ...options, metadataMode: 'automatic'}]);
  assert.deepEqual(await page.evaluate(() => ({
    nativeRequire: typeof window.require,
    generalApi: typeof window.roc.research.importDocument,
    exposedResolver: typeof window.rocPdfDrop.getPathForFile,
    exposedIpc: typeof window.rocPdfDrop.ipcRenderer
  })), {nativeRequire: 'undefined', generalApi: 'function', exposedResolver: 'undefined', exposedIpc: 'undefined'});
});

test('constructed files, forged paths and native non-PDF files fail before any import request', async () => {
  const before = (await requests()).length;
  const forged = await page.evaluate(async ({options, pdf}) => {
    const constructed = await window.rocPdfDrop.importPdf(new File(['%PDF-1.7'], 'fake.pdf'), options);
    const plainObject = await window.rocPdfDrop.importPdf({name: 'fake.pdf', path: pdf}, options);
    return [constructed, plainObject];
  }, {options, pdf});
  await page.getByLabel('Native file').setInputFiles(text);
  const nonPdf = await page.evaluate(options =>
    window.rocPdfDrop.importPdf(document.querySelector('input').files[0], options), options);
  for (const result of [...forged, nonPdf]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'pdf_drop_source_invalid');
    assert.equal(result.error.category, 'validation');
    assert.equal(JSON.stringify(result).includes(directory), false);
  }
  assert.equal((await requests()).length, before);
});

test('the existing manual DTO and backend failures retain their contracts without leaking rejected transport details', async () => {
  assert.deepEqual(await importNative(), documentResult);
  assert.deepEqual((await requests()).at(-1), {target: 'new-item', sourcePath: pdf, ...options});
  const backendFailure = {ok: false, error: {code: 'destination_locked', message: '项目不可写。',
    category: 'permission', retryable: false}};
  await app.evaluate((_electron, reply) => {globalThis.pdfDropReply = reply;}, backendFailure);
  assert.deepEqual(await importNative(), backendFailure);
  const beforeInvalid = (await requests()).length;
  const invalid = await importNative(null);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'pdf_drop_options_invalid');
  assert.equal((await requests()).length, beforeInvalid);
  await app.evaluate((_electron, message) => {globalThis.pdfDropThrow = message;}, `transport failed for ${pdf}`);
  const rejected = await importNative();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'pdf_drop_import_failed');
  assert.equal(JSON.stringify(rejected).includes(directory), false);
});
