import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';
import { buildViteRenderer } from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const pageErrors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-reading-note-guards-'));
  await buildViteRenderer({ directory, script: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { LazyMotion, domAnimation, MotionConfig } from 'motion/react';
    import ReadingNotesPanel from './src/renderer/literature/ReadingNotesPanel';
    import { readingNoteSaveSchema, readingNoteExportSchema, readingNoteDeleteSchema } from './src/shared/schemas/research-reading';
    const root = createRoot(document.getElementById('root'));
    let session = 0, stored;
    const client = {api:{research:{
      listReadingNotes: () => {
        window.listCalls++;
        if (window.listMode === 'throw') throw new Error('Synthetic reread transport failure');
        if (window.listMode === 'refuse') return Promise.resolve({ok:false,error:{message:'Synthetic reread refused'}});
        if (window.listMode === 'pending') return new Promise(resolve => {window.resolveList = () => resolve({ok:true,data:[stored]});});
        return Promise.resolve({ok:true,data:stored?[stored]:[]});
      },
      saveReadingNote: raw => {
        const {expectedRevision,...input} = readingNoteSaveSchema.parse(raw);
        window.saveCalls++;
        window.saveInput = input;
        if (window.saveMode === 'refuse') return Promise.resolve({ok:false,error:{message:'Synthetic note revision conflict'}});
        const finish = () => {
          stored = {...input,revision:expectedRevision+1,links:[],createdAt:'2026-11-10',updatedAt:'2026-11-12'};
          return {ok:true,data:stored};
        };
        if (window.saveMode === 'pending') return new Promise(resolve => {window.resolveSave = () => resolve(finish());});
        return Promise.resolve(finish());
      },
      deleteReadingNote: raw => {
        readingNoteDeleteSchema.parse(raw);
        window.deleteCalls++;
        window.deleteInput = raw;
        if (window.deleteMode === 'throw') throw new Error('Synthetic delete transport failure');
        if (window.deleteMode === 'refuse') return Promise.resolve({ok:false,error:{message:'Synthetic delete revision conflict'}});
        const finish = () => {stored = null;return {ok:true,data:{}};};
        if (window.deleteMode === 'pending') return new Promise(resolve => {window.resolveDelete = () => resolve(finish());});
        return Promise.resolve(finish());
      },
      exportReadingNote: raw => {
        readingNoteExportSchema.parse(raw);
        window.exportCalls++;
        if (window.exportMode === 'throw') throw new Error('Synthetic export transport failure');
        if (window.exportMode === 'refuse') return Promise.resolve({ok:false,error:{message:'Synthetic export refused'}});
        if (window.exportMode === 'pending') return new Promise(resolve => {window.resolveExport = () => resolve({ok:true,data:{path:null}});});
        return Promise.resolve({ok:true,data:{path:'/tmp/synthetic-note.md'}});
      }
    }}};
    window.mountNotes = (writable = true) => {
      window.listMode = window.saveMode = window.exportMode = window.deleteMode = 'ready';
      window.listCalls = window.saveCalls = window.exportCalls = window.deleteCalls = 0;
      stored = {id:'note',projectId:'fixture',itemId:null,title:'Stored note',markdown:'Stored body',
        archived:false,revision:1,links:[],createdAt:'2026-11-10',updatedAt:'2026-11-10'};
      flushSync(() => root.render(<LazyMotion features={domAnimation}><MotionConfig reducedMotion="user"><div style={{height:620,width:620}}>
        <ReadingNotesPanel key={++session} client={client} projectId="fixture" items={[]} writable={writable}/>
      </div></MotionConfig></LazyMotion>));
    };
  `, style: 'html,body{margin:0}' });
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:720,height:780}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.waitForFunction(() => typeof window.mountNotes === 'function');
});
after(async () => {
  try { await app?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

async function openStoredNote() {
  pageErrors.length = 0;
  await page.evaluate(() => window.mountNotes());
  await page.getByLabel('选择笔记', { exact: true }).selectOption('note');
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('Stored note');
  await page.getByTestId('notes-options').click();
}

async function makeConflict() {
  await openStoredNote();
  await page.evaluate(() => { window.saveMode = 'refuse'; });
  await page.getByLabel('笔记标题', { exact: true }).fill('Local unsaved note');
  await page.getByTestId('notes-save').click();
  await expect(page.getByRole('alert')).toContainText('Synthetic note revision conflict');
}

test('native note export rejects duplicate invocation while the save dialog is open', async () => {
  await openStoredNote();
  await page.evaluate(() => {
    window.exportMode = 'pending';
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === '导出 .md');
    button.click(); button.click();
  });
  assert.equal(await page.evaluate(() => window.exportCalls), 1);
  await expect(page.getByRole('button', { name: '导出 .md', exact: true })).toBeDisabled();
  await page.evaluate(() => window.resolveExport());
  await expect(page.getByRole('button', { name: '导出 .md', exact: true })).toBeEnabled();
  assert.deepEqual(pageErrors, []);
});

test('note export reports thrown failures without losing the note', async () => {
  await openStoredNote();
  await page.evaluate(() => { window.exportMode = 'throw'; });
  await page.getByRole('button', { name: '导出 .md', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic export transport failure');
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('Stored note');
  assert.deepEqual(pageErrors, []);
});

test('note deletion requires confirmation, blocks duplicate requests and removes the selected note', async () => {
  await openStoredNote();
  await expect(page.getByTestId('notes-delete')).toBeVisible();
  await page.getByTestId('notes-delete').focus();
  await expect(page.getByTestId('notes-delete')).toBeFocused();
  await page.getByTestId('notes-delete').press('Enter');
  const dialog=page.getByTestId('notes-delete-dialog');
  await expect(dialog).toContainText('Stored note');
  await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.deleteCalls),0);
  await expect(page.getByTestId('notes-delete')).toBeFocused();
  await page.evaluate(()=>{window.deleteMode='pending';});
  await page.getByTestId('notes-delete').click();
  await page.getByTestId('notes-delete-dialog-confirm').evaluate(button=>{button.click();button.click();});
  assert.equal(await page.evaluate(()=>window.deleteCalls),1);
  assert.deepEqual(await page.evaluate(()=>window.deleteInput),{projectId:'fixture',noteId:'note',expectedRevision:1});
  await expect(page.getByTestId('notes-delete-dialog-confirm')).toBeDisabled();
  await expect(page.getByTestId('notes-delete-dialog-cancel')).toBeDisabled();
  await expect(page.getByLabel('笔记标题',{exact:true})).toBeDisabled();
  await page.evaluate(()=>window.resolveDelete());
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveCount(0);
  await expect(page.getByLabel('选择笔记',{exact:true}).locator('option[value="note"]')).toHaveCount(0);
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('笔记已删除');
  assert.equal(await page.evaluate(()=>window.saveCalls),0);
  assert.deepEqual(pageErrors,[]);
});

test('failed note deletion preserves unsaved drafts and never resumes stale autosave', async () => {
  await openStoredNote();
  await page.evaluate(()=>{window.deleteMode='refuse';});
  await page.getByLabel('笔记标题',{exact:true}).fill('Unsaved draft');
  await page.getByTestId('notes-delete').click();
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(()=>window.saveCalls),0);
  await page.getByTestId('notes-delete-dialog-confirm').click();
  await expect(page.getByRole('alert')).toContainText('Synthetic delete revision conflict');
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue('Unsaved draft');
  await page.evaluate(()=>{window.deleteMode='throw';});
  await page.getByTestId('notes-delete').click();
  await page.getByTestId('notes-delete-dialog-confirm').click();
  await expect(page.getByRole('alert')).toContainText('Synthetic delete transport failure');
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue('Unsaved draft');
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(()=>window.saveCalls),0);
  assert.deepEqual(pageErrors,[]);
});

test('deletion stays disabled for read-only projects', async () => {
  await page.evaluate(()=>window.mountNotes(false));
  await page.getByLabel('选择笔记',{exact:true}).selectOption('note');
  await page.getByTestId('notes-options').click();
  await expect(page.getByTestId('notes-delete')).toBeDisabled();
});

test('rereading a conflicted note confirms discard, freezes replacement and retains the draft on failure', async () => {
  await makeConflict();
  await page.getByRole('button', { name: '放弃草稿并重读', exact: true }).click();
  const confirmation = page.getByTestId('notes-discard-dialog');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('Local unsaved note');
  await page.evaluate(() => { window.listMode = 'throw'; });
  await page.getByRole('button', { name: '放弃草稿并重读', exact: true }).click();
  await confirmation.getByRole('button', { name: '放弃草稿并重读', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic reread transport failure');
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('Local unsaved note');
  await page.evaluate(() => { window.listMode = 'pending'; });
  await page.getByRole('button', { name: '放弃草稿并重读', exact: true }).click();
  await confirmation.getByRole('button', { name: '放弃草稿并重读', exact: true }).click();
  await expect(page.getByLabel('笔记标题', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '将草稿另存为副本', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.listMode = 'ready'; window.resolveList(); });
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('Stored note');
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
  assert.deepEqual(pageErrors, []);
});

test('formula composition confirmation does not insert or erase unfinished LaTeX', async () => {
  await openStoredNote();
  await page.getByRole('button', {name: '公式', exact: true}).click();
  const input = page.getByLabel('LaTeX 公式', { exact: true });
  await input.fill('x^2');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await input.press('Enter');
  await expect(input).toHaveValue('x^2');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('notes-editor').locator('.katex')).toBeVisible();
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.getByLabel('Markdown 源码', { exact: true })).toHaveValue(/x\^2/u);
  assert.deepEqual(pageErrors, []);
});

test('note save preserves edits made after submission and writes the latest draft on retry', async () => {
  await openStoredNote();
  await page.evaluate(() => { window.saveMode = 'pending'; });
  await page.getByLabel('笔记标题', { exact: true }).fill('Submitted title');
  await page.getByTestId('notes-save').click();
  await page.getByLabel('笔记标题', { exact: true }).fill('Later title');
  await page.evaluate(() => window.resolveSave());
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('Later title');
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('未保存');
  await page.evaluate(() => { window.saveMode = 'ready'; });
  await page.getByTestId('notes-save').click();
  assert.equal(await page.evaluate(() => window.saveInput.title), 'Later title');
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
  assert.deepEqual(pageErrors, []);
});


test('formula drafts and Markdown source render math live without saving or exposing raw HTML', async () => {
  await openStoredNote();
  await page.getByTestId('notes-options').click();
  await page.getByRole('button', {name:'公式',exact:true}).click();
  const input=page.getByLabel('LaTeX 公式', {exact:true});
  await input.fill('\\frac{a}{b}');
  await expect(page.getByTestId('notes-formula-preview').locator('.katex')).toBeVisible();
  assert.equal(await page.getByTestId('notes-editor').locator('.katex').count(),0);
  await input.fill('\\frac{');
  await expect(page.getByTestId('notes-formula-preview')).toContainText('公式尚未完整');
  await input.fill('x^2');
  await expect(page.getByTestId('notes-formula-preview').locator('.katex')).toBeVisible();
  await page.getByRole('button', {name:'Markdown 源码',exact:true}).click();
  const source=page.getByLabel('Markdown 源码',{exact:true});
  await source.fill('# Live preview\n\nInline $E=mc^2$\n\n$$\n\\frac{a}{b}\n$$\n\n<script>window.mathUnsafe=true</script>');
  const preview=page.getByTestId('notes-markdown-preview');
  await expect(preview.getByRole('heading',{name:'Live preview'})).toBeVisible();
  await expect(preview.locator('.katex')).toHaveCount(2);
  assert.equal(await page.evaluate(()=>window.mathUnsafe),undefined);
  assert.equal(await preview.locator('script').count(),0);
  await page.evaluate(()=>{document.getElementById('root').firstElementChild.style.width='420px';});
  const sourceBounds=await source.boundingBox();
  const previewBounds=await preview.boundingBox();
  assert.ok(sourceBounds.y+sourceBounds.height<=previewBounds.y+1,'source must not overlap its live preview');
  assert.ok(previewBounds.height>=140,'live preview retains a readable height');
  await source.fill('Unclosed $x +');
  await expect(preview).toContainText('Unclosed $x +');
  await source.fill('$$\n\\frac{\n$$');
  await expect(preview.locator('.katex-error')).toBeVisible();
  await page.getByTestId('notes-save').click();
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
  assert.deepEqual(pageErrors,[]);
});
