import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
const clipSource = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
const markdown = '# Research notes\n\nEnergy is $E=mc^2$.\n\n## Findings\n\nA readable document with a live equation.';
const formula = String.raw`\[\frac{a}{b}=c^2\]`;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-authoring-tools-'));
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}#root{overflow:hidden}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {EditorView} from '@codemirror/view';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {LatexPanel} from './src/renderer/latex/LatexPanel';
    import {FilePreview} from './src/renderer/canvas/files/FilePreview';
    import {GitPanel} from './src/renderer/canvas/git/GitPanel';
    import {TerminalSessionView} from './src/renderer/canvas/terminal/TerminalView';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {useFileTree} from './src/renderer/workspace/use-file-tree';
    import {ViewActivity} from './src/renderer/shared/view-activity';
    const ok = data => ({ok: true, data});
    window.readManuscript=()=>EditorView.findFromDOM(document.querySelector('.authoring-source .cm-content'))?.state.doc.toString();
    const contents = {'main.tex': ${JSON.stringify(formula)}, 'notes.md': ${JSON.stringify(markdown)}, 'chapters/intro.tex':'Introduction'};
    window.setWorkspaceFile=(path,content)=>{if(content===null)delete contents[path];else contents[path]=content;};
    const snapshot = {id: 'terminal-fixture', cwd: '/synthetic', shell: '/bin/zsh', status: 'ready', exitCode: null};
    window.writes = []; window.inlineCommands = []; window.terminalCreates = []; window.terminalInputs = []; window.terminalCloses = []; window.terminalDetaches = []; window.terminalAttaches = [];
    let terminalOutput='', terminalSequence=0, terminalLease=0, outputListener=null, exitListener=null;
    window.emitOutput=event=>{const startSequence=terminalSequence;terminalOutput+=event.data;terminalSequence+=event.data.length;outputListener?.({...event,attachmentId:String(terminalLease),startSequence,sequence:terminalSequence});};
    window.emitExit=event=>exitListener?.({...event,attachmentId:String(terminalLease)});
    window.addEventListener('roc:inline-selection-command', event => window.inlineCommands.push(event.detail));
    window.compiles = []; window.exports = []; window.pdfRequests = []; window.compileMode = 'ready'; window.exportPath = null;
    window.fileListMode = 'ready'; window.fileScans = 0; window.fileReads=[]; window.includeNested=false;
    const workspaceListeners=new Set();
    const polishListeners=new Set();window.polishStarts=[];window.polishMode='pending';window.polishAccepted=[];
    window.emitPolish=(message,kind='run_completed',runId=window.polishReceipt?.runId)=>{
      const event={type:kind,runId,threadId:window.polishReceipt.threadId,
        assistantMessage:'Read-only reference checked. '+message,validatedResponse:message,message:'Provider unavailable'};
      for(const listener of polishListeners)listener(event);
    };
    window.polishListenerCount=()=>polishListeners.size;
    window.emitWorkspace=relativePath=>{for(const listener of workspaceListeners)listener({workspacePath:'/synthetic',relativePath,eventType:'change'});};
    const client = {api: {
      workspace: {getCurrent:async()=>ok({path:'/synthetic'}),onChanged: listener => {workspaceListeners.add(listener);return()=>workspaceListeners.delete(listener);}},
      chat:{
        onRunEvent:listener=>{polishListeners.add(listener);return()=>polishListeners.delete(listener);},
        startRun:async request=>{window.polishStarts.push(request);
          if(window.polishMode==='error')return {ok:false,error:{message:'Model not configured'}};
          window.polishReceipt={runId:'polish-'+window.polishStarts.length,threadId:'polish-thread-'+window.polishStarts.length,mode:request.mode};
          return ok(window.polishReceipt);},
        replayRunEvents:async request=>ok({kind:'events',runId:request.runId,events:[]})
      },
      files: {
        listTree: async ({relativePath}) => {window.fileScans++;window.fileReads.push(relativePath);
          const names=Object.keys(contents).filter(name=>relativePath==='chapters'?name.startsWith('chapters/'):!name.includes('/'));
          return window.fileListMode === 'error' ? {ok:false,error:{message:'Scan unavailable'}} :
            ok({workspacePath:'/synthetic',relativePath, truncated: window.fileListMode === 'partial', entries: window.fileListMode === 'empty' ? [] : [
              ...names.map(name=>({name:name.split('/').at(-1), relativePath: name, type: 'file', size: contents[name].length, updatedAt: '2026-11-12T00:00:00.000Z'})),
              ...(relativePath===''&&window.includeNested?[{name:'chapters',relativePath:'chapters',type:'directory',size:0,updatedAt:'2026-11-12T00:00:00.000Z'}]:[])]});},
        preview: async ({relativePath}) => ok({relativePath, kind: 'text', content: contents[relativePath],
          sizeBytes: contents[relativePath].length, truncated: false, mediaType: 'text/plain'}),
        previewPdf: async request => {window.pdfRequests.push(request); return ok({relativePath: request.relativePath, resourceUrl: 'about:blank', sizeBytes: 1024});},
        writeText: async request => {window.writes.push(request); contents[request.relativePath] = request.content;
          return ok({relativePath: request.relativePath, bytesWritten: request.content.length,
            recoveryPoint: {createdAt: '2026-11-12T00:00:00.000Z'}});}
      },
      research: {
        compileWorkspaceLatex: async request => {
          window.compiles.push({...request, content: contents[request.entryPath]});
          const result = {requestId: request.requestId, entryPath: request.entryPath, status: window.compileMode,
            outputPath: '.roc-build/latex/' + request.requestId + '.pdf', pdfHash: 'a'.repeat(64), diagnostics: []};
          if (window.compileMode === 'pending') return await new Promise(resolve => {window.finishCompile = () => resolve(ok({...result, status: 'cancelled', outputPath: null, pdfHash: null}));});
          if (window.compileMode === 'failed') return ok({...result, outputPath: null, pdfHash: null,
            diagnostics: [{severity: 'error', file: 'main.tex', line: 3, message: 'Undefined control sequence'}]});
          return ok(result);
        },
        cancelWorkspaceLatex: async () => ok({requested: true}),
        exportWorkspaceLatex: async request => {window.exports.push(request); return ok({path: window.exportPath});}
      },
      git: {
        status: async () => ok({branch: 'main', changedFiles: 1, changes: [{relativePath: 'notes.md', index: ' ', worktree: 'M'}]}),
        diffStat: async () => ok({stat: 'notes.md | 2 +-' }),
        listBranches: async () => ok({currentBranch: 'main', branches: [{name: 'main', current: true}]}),
        push: async () => ({ok: false, error: {message: 'Remote is unavailable'}}),
        fileDiff: async ({relativePath}) => ok({relativePath, patch: 'diff --git a/notes.md b/notes.md\\nindex 3367afd..3e75765 100644\\n--- a/notes.md\\n+++ b/notes.md\\n@@ -1 +1 @@\\n-old result\\n+new result\\n'})
      },
      rtk: {status: async () => ok({binaryPath: '/rtk', configPath: '/config', teeDir: '', resourceState: 'ready', enabledForAgentCommands: true})},
      terminal: {
        onOutput: callback => {outputListener = callback; return () => {outputListener = null;};},
        onExit: callback => {exitListener = callback; return () => {exitListener = null;};},
        createSession: async request => {window.terminalCreates.push(request); return ok({...snapshot, ...request});},
        attachSession: async request => {window.terminalAttaches.push(request);if(terminalLease===0)window.terminalCreates.push(request);
          return ok({session:{...snapshot,...request},attachmentId:String(++terminalLease),
            replay:{startSequence:0,sequence:terminalSequence,data:terminalOutput,truncated:!!window.replayTruncated}});},
        detachSession: async request => {window.terminalDetaches.push(request);return ok({closed:true});},
        resize: async request => ok({...snapshot, ...request}),
        writeInput: async request => {window.terminalInputs.push(request); return ok(true);},
        closeSession: async request => {window.terminalCloses.push(request);
          window.emitExit({sessionId:request.sessionId,exitCode:0}); await Promise.resolve(); return ok(true);}
      }
    }};
    const scope = {client, projectId: 'fixture', workspacePath: '/synthetic', writable: true,
      workspaceStatus: 'bound', workspaceError: null, openFileInCanvas: () => {}, rebindWorkspace: () => {},
      adoptAcceptedRun:({receipt})=>window.polishAccepted.push(receipt)};
    const root = createRoot(document.getElementById('root'));
    function WritingFixture(){
      const tree=useFileTree(client,{workspacePathKey:'/synthetic',projectId:'fixture'});
      const [writerEpoch,setWriterEpoch]=useState(0);
      const [writingActive,setWritingActive]=useState(true);
      window.treeRows=tree.rows;window.expandDirectory=path=>tree.expandDirectories([path]);window.collapseDirectories=tree.collapseAll;
      window.remountWriting=()=>setWriterEpoch(value=>value+1);
      window.setWritingActive=setWritingActive;
      return <ViewActivity active={writingActive}><div hidden={!writingActive} style={{height:'100%'}}><LatexPanel key={writerEpoch}/></div></ViewActivity>;
    }
    function TerminalFixture(){
      const [active,setActive]=useState(true);window.setTerminalActive=setActive;
      return <ViewActivity active={active}><div hidden={!active} style={{height:'100%'}}>
        <TerminalSessionView client={client} projectId="fixture" workspacePath="/synthetic" writable />
      </div></ViewActivity>;
    }
    let epoch = 0;
    window.unmount = () => flushSync(() => root.render(null));
    window.mount = mode => {
      window.unmount();
      const child = mode === 'latex' ? <WritingFixture /> : mode === 'file' ?
        <FilePreview client={client} projectId="fixture" workspacePath="/synthetic" relativePath="notes.md" writable /> :
        mode === 'git' ? <GitPanel client={client} workspacePath="/synthetic" writable layout="drawer" /> :
        <TerminalFixture />;
      flushSync(() => root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
        <WorkspaceScopeProvider value={scope}><main key={++epoch} style={{height: '100%', minWidth: 0}}>{child}</main></WorkspaceScopeProvider>
      </LazyMotion></MotionConfig>));
    };
    window.mount('latex');
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show: false, width: 1200, height: 800})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('production-latex-file-main.tex').waitFor();
});

after(async () => {
  try { await page?.evaluate(() => window.unmount()); await app?.close(); }
  finally { if (directory) await rm(directory, {recursive: true, force: true}); }
  assert.deepEqual(errors, []);
});

async function audit() {
  const result = await page.evaluate(source => (0, eval)(source)({root: '#root', viewport: true}), clipSource);
  assert.equal(result.cut, 0, JSON.stringify(result.issues));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}

async function selectFile(path) {
  const picker = page.getByRole('combobox', {name: '选择文稿文件'});
  if (await picker.isVisible()) await picker.selectOption(path);
  else await page.getByTestId('production-latex-file-' + path).click();
  await expect(page.getByTestId('production-latex-content')).toBeVisible();
}

test('partial empty and failed manuscript lists keep one scan action', async () => {
  try {
    for (const mode of ['partial', 'empty', 'error']) {
      await page.evaluate(mode => {window.fileListMode=mode;window.mount('latex');}, mode);
      if (mode === 'partial') await expect(page.getByText('部分文稿未列出',{exact:true}).first()).toBeVisible();
      else if (mode === 'empty') await expect(page.getByTestId('production-latex-empty').first()).toBeVisible();
      else await expect(page.getByRole('alert').first()).toContainText('Scan unavailable');
      const scan=page.getByRole('button',{name:/^(重新扫描|重试)$/});
      await expect(scan).toHaveCount(1);
      const before=await page.evaluate(()=>{window.fileListMode='ready';return window.fileScans;});
      await scan.focus();await page.keyboard.press('Enter');
      await expect(page.getByTestId('production-latex-file-main.tex')).toBeVisible();
      assert.equal(await page.evaluate(()=>window.fileScans),before+1);
    }
  } finally {
    await page.evaluate(()=>{window.fileListMode='ready';window.mount('latex');});
  }
});

test('authoring uses real Markdown math previews and protects drafts when changing files', async () => {
  await page.evaluate(() => window.mount('latex'));
  await selectFile('notes.md');
  await page.getByTestId('latex-toggle-preview').click();
  const preview = page.getByRole('region', {name: 'Markdown 实时预览'});
  await expect(preview.locator('.katex')).toHaveCount(1);
  const source = page.getByTestId('production-latex-content');
  await source.fill('# Updated\n\n$F=ma$');
  await expect(preview.getByRole('heading', {name: 'Updated'})).toBeVisible();
  await expect(preview.locator('.katex')).toHaveCount(1);
  await page.getByTestId('production-latex-file-main.tex').click();
  const guard = page.getByTestId('latex-unsaved');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', {name: '取消', exact: true}).click();
  await expect(source).toHaveText('# Updated$F=ma$');
  await page.getByTestId('production-latex-save').click();
  await expect(page.getByTestId('latex-dirty-indicator')).toHaveText('已保存');
  assert.equal(await page.evaluate(() => window.writes.at(-1).content), '# Updated\n\n$F=ma$');
  await selectFile('main.tex');
  await expect(page.getByRole('region', {name: '所选公式预览'})).toContainText('选中源码中的公式以预览');
  await source.focus();
  await source.press('Meta+A');
  await expect(page.getByRole('region', {name: '所选公式预览'}).locator('.katex')).toHaveCount(1);
  assert.equal(await page.getByRole('region', {name: 'Markdown 实时预览'}).count(), 0);
});

test('writing reuses sidebar directory reads across remounts and external changes preserve the draft', async () => {
  await page.evaluate(() => {window.includeNested=true;window.fileReads=[];window.mount('latex');});
  try {
    await expect(page.getByTestId('production-latex-file-chapters/intro.tex')).toBeVisible();
    assert.deepEqual(await page.evaluate(()=>window.fileReads),['','chapters']);
    await page.evaluate(()=>window.expandDirectory('chapters'));
    await page.waitForFunction(()=>window.treeRows.some(row=>row.entry.relativePath==='chapters/intro.tex'));
    assert.deepEqual(await page.evaluate(()=>window.fileReads),['','chapters']);
    await page.evaluate(()=>window.remountWriting());
    await expect(page.getByTestId('production-latex-file-chapters/intro.tex')).toBeVisible();
    assert.deepEqual(await page.evaluate(()=>window.fileReads),['','chapters']);
    await selectFile('notes.md');
    await page.getByTestId('production-latex-content').fill('Unsaved local draft');
    await page.evaluate(()=>{window.fileReads=[];window.emitWorkspace('chapters/intro.tex');});
    await expect.poll(()=>page.evaluate(()=>window.fileReads.length)).toBe(2);
    assert.deepEqual(await page.evaluate(()=>window.fileReads),['','chapters']);
    await expect(page.getByTestId('production-latex-content')).toHaveText('Unsaved local draft');
    await expect(page.getByTestId('latex-dirty-indicator')).toHaveText('未保存');
  } finally {
    await page.evaluate(()=>{window.collapseDirectories();window.includeNested=false;window.mount('latex');});
  }
});

test('hidden writing pauses directory scans and save shortcuts while the sidebar and draft survive', async () => {
  await page.evaluate(()=>{window.includeNested=true;window.mount('latex');});
  try {
    await expect(page.getByTestId('production-latex-file-chapters/intro.tex')).toBeVisible();
    await selectFile('notes.md');
    const editor=page.getByTestId('production-latex-content');
    const draft='# Retained draft\n\n'+Array.from({length:80},(_,index)=>'Reading paragraph '+index+' with $F=ma$.').join('\n\n');
    await editor.fill(draft);
    await page.getByTestId('latex-toggle-preview').click();
    await expect(page.getByRole('heading',{name:'Retained draft'})).toBeVisible();
    const reading=page.locator('.authoring-preview-content');
    await expect(reading.locator('.katex')).toHaveCount(80);
    await reading.evaluate(node=>{node.scrollTop=720;});
    const readingTop=await reading.evaluate(node=>node.scrollTop);
    assert(readingTop>500);
    const writes=await page.evaluate(()=>window.writes.length);
    await page.evaluate(()=>window.setWritingActive(false));
    await expect(editor).toBeHidden();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.scientific-markdown,.authoring-preview-content .katex')).toHaveCount(0);
    await page.evaluate(()=>{
      window.fileReads=[];
      window.setWorkspaceFile('sidebar-new.md','Sidebar change');
      window.setWorkspaceFile('chapters/new.tex','New chapter');
      window.emitWorkspace('chapters/new.tex');
    });
    await page.waitForFunction(()=>window.treeRows.some(row=>row.entry.relativePath==='sidebar-new.md'));
    assert.deepEqual(await page.evaluate(()=>window.fileReads),[''],'the sidebar keeps watching without scanning the hidden writing directory');
    await page.keyboard.press('Meta+s');
    assert.equal(await page.evaluate(()=>window.writes.length),writes,'hidden writing does not receive the active surface save shortcut');
    await page.evaluate(()=>window.setWritingActive(true));
    await expect(page.getByTestId('production-latex-file-chapters/new.tex')).toBeVisible();
    assert.deepEqual(await page.evaluate(()=>window.fileReads),['','chapters'],'resuming reads only invalidated metadata');
    assert.equal(await page.evaluate(()=>window.readManuscript()),draft);
    await expect(page.getByTestId('latex-dirty-indicator')).toHaveText('未保存');
    await expect(page.getByTestId('latex-toggle-preview')).toHaveAttribute('aria-pressed','true');
    await expect(reading.locator('.katex')).toHaveCount(80);
    await expect.poll(()=>reading.evaluate(node=>node.scrollTop)).toBe(readingTop);
  } finally {
    await page.evaluate(()=>{
      window.setWorkspaceFile('sidebar-new.md',null);window.setWorkspaceFile('chapters/new.tex',null);
      window.collapseDirectories();window.includeNested=false;window.mount('latex');
    });
  }
});

test('hidden writing releases formula rendering and restores the selected formula on return',async()=>{
  await page.evaluate(formula=>{window.setWorkspaceFile('main.tex',formula);window.mount('latex');},formula);
  await selectFile('main.tex');
  const toggle=page.getByTestId('latex-toggle-preview');
  if(await toggle.getAttribute('aria-pressed')!=='true')await toggle.click();
  const editor=page.getByTestId('production-latex-content');
  await editor.focus();await page.keyboard.press('Meta+a');
  const preview=page.getByRole('region',{name:'所选公式预览'});
  await expect(preview.locator('.katex')).toHaveCount(1);
  await page.evaluate(()=>window.setWritingActive(false));
  await expect(page.locator('.authoring-preview-content .katex')).toHaveCount(0);
  await page.evaluate(()=>window.setWritingActive(true));
  await expect(toggle).toHaveAttribute('aria-pressed','true');
  await expect(preview.locator('.katex')).toHaveCount(1);
});

test('selected LaTeX exposes scoped commands and applies a confirmed replacement to the saveable draft', async () => {
  await page.evaluate(() => window.mount('latex'));
  await selectFile('main.tex');
  const editor = page.getByTestId('production-latex-content');
  await editor.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Meta+k');
  const commands = page.getByTestId('inline-command-bar');
  await expect(commands).toBeVisible();
  const writesBeforeCommand = await page.evaluate(() => window.writes.length);
  await page.getByTestId('inline-command-explain').click();
  const dispatched = await page.evaluate(() => window.inlineCommands.at(-1));
  assert.equal(dispatched.action, 'explain');
  assert.deepEqual(dispatched.context, {
    filePath: 'main.tex',
    selectionText: formula,
    lineRange: {start: 1, end: 1},
    source: 'workspace-file'
  });
  assert.equal(await page.evaluate(() => window.writes.length), writesBeforeCommand, 'an assistant request alone does not write the file');

  await page.getByTestId('inline-command-edit-selection').click();
  const replacement = String.raw`\section{Reviewed}`;
  await page.getByTestId('inline-command-replacement-input').fill(replacement);
  await expect(page.getByTestId('inline-command-replacement')).toHaveText(replacement);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.setViewportSize({width: 440, height: 540});
    const apply = page.getByTestId('inline-command-apply-edit');
    await apply.scrollIntoViewIfNeeded();
    await apply.focus();
    await expect.poll(() => commands.evaluate(node => {
      const {left, top, right, bottom} = node.getBoundingClientRect();
      const gutter = Number.parseFloat(getComputedStyle(node).getPropertyValue('--shadow-popover-gutter'));
      return left >= gutter && top >= gutter && right <= innerWidth - gutter && bottom <= innerHeight - gutter;
    })).toBe(true);
    await audit();
    const bounds = await commands.boundingBox();
    assert.ok(bounds.x >= 28 && bounds.y >= 28 && bounds.x + bounds.width <= 412 && bounds.y + bounds.height <= 512,
      `selection editor and shadow fit ${theme} short viewport`);
  }
  await page.setViewportSize({width: 1200, height: 800});
  await page.getByTestId('inline-command-apply-edit').click();
  await expect(editor).toHaveText(replacement);
  await expect(page.getByTestId('latex-dirty-indicator')).toHaveText('未保存');
  assert.equal(await page.evaluate(() => window.writes.length), writesBeforeCommand, 'confirmed diff updates the draft; save stays explicit');

  await page.getByTestId('production-latex-save').click();
  await expect(page.getByTestId('latex-dirty-indicator')).toHaveText('已保存');
  assert.equal(await page.evaluate(() => window.writes.at(-1).content), replacement);
});

test('polish consumes a real run receipt and matching terminal result, previews the diff, then changes only the draft', async () => {
  await page.evaluate(() => {window.setWorkspaceFile('main.tex','Original paragraph');window.polishMode='pending';window.mount('latex');});
  await selectFile('main.tex');
  const editor=page.getByTestId('production-latex-content');
  await editor.click();await page.keyboard.press('Meta+a');
  const starts=await page.evaluate(()=>window.polishStarts.length);
  const writes=await page.evaluate(()=>window.writes.length);
  await page.getByTestId('inline-command-polish').click();
  await expect.poll(()=>page.evaluate(()=>window.polishStarts.length)).toBe(starts+1);
  await expect(page.getByTestId('inline-command-polish')).toBeDisabled();
  const request=await page.evaluate(()=>window.polishStarts.at(-1));
  assert.equal(request.mode,'plan');assert.equal(request.researchProjectId,'fixture');
  assert.equal((await page.evaluate(()=>window.polishAccepted.at(-1))).runId,'polish-'+(starts+1));
  await page.evaluate(()=>window.emitPolish(JSON.stringify({requestId:window.polishStarts.at(-1).dispatchKey,replacement:'Reviewed paragraph'}),'run_completed','unrelated-run'));
  await expect(page.getByTestId('inline-command-proposal')).toHaveCount(0);
  await page.evaluate(()=>window.emitPolish(JSON.stringify({requestId:window.polishStarts.at(-1).dispatchKey,replacement:'Reviewed paragraph'})));
  await expect(page.getByTestId('inline-command-original')).toHaveText('- Original paragraph');
  await expect(page.getByTestId('inline-command-replacement')).toHaveText('+ Reviewed paragraph');
  await expect(editor).toHaveText('Original paragraph');
  assert.equal(await page.evaluate(()=>window.polishListenerCount()),0);
  await page.getByTestId('inline-command-accept').click();
  await expect(editor).toHaveText('Reviewed paragraph');
  assert.equal(await page.evaluate(()=>window.writes.length),writes);
  await page.getByTestId('production-latex-save').click();
  await expect(page.getByTestId('latex-dirty-indicator')).toHaveText('已保存');
  assert.equal(await page.evaluate(()=>window.writes.at(-1).content),'Reviewed paragraph');
});

test('polish rejects a changed disk version and invalidates requests after editing even if the draft is restored', async () => {
  await page.evaluate(() => {window.setWorkspaceFile('main.tex','Version one');window.mount('latex');});
  await selectFile('main.tex');
  const editor=page.getByTestId('production-latex-content');
  await editor.click();await page.keyboard.press('Meta+a');
  await page.getByTestId('inline-command-polish').click();
  await expect.poll(()=>page.evaluate(()=>window.polishListenerCount())).toBe(1);
  await page.evaluate(()=>window.emitPolish(JSON.stringify({requestId:window.polishStarts.at(-1).dispatchKey,replacement:'Version two'})));
  await expect(page.getByTestId('inline-command-proposal')).toBeVisible();
  await page.evaluate(()=>window.setWorkspaceFile('main.tex','External edit'));
  await page.getByTestId('inline-command-accept').click();
  await expect(page.getByTestId('production-latex-save-note')).toContainText('原文件已变化');
  await expect(editor).toHaveText('Version one');
  await expect(page.getByTestId('inline-command-proposal')).toHaveCount(0);
  await page.evaluate(()=>window.setWorkspaceFile('main.tex','Version one'));
  await page.getByTestId('inline-command-polish').click();
  await expect.poll(()=>page.evaluate(()=>window.polishListenerCount())).toBe(1);
  const requestId=await page.evaluate(()=>window.polishStarts.at(-1).dispatchKey);
  await editor.click();await page.keyboard.press('Meta+a');await page.keyboard.type('Changed locally');
  await expect.poll(()=>page.evaluate(()=>window.polishListenerCount())).toBe(0);
  await page.keyboard.press('Meta+z');await page.keyboard.press('Meta+a');
  await page.evaluate(requestId=>window.emitPolish(JSON.stringify({requestId,replacement:'Stale replacement'})),requestId);
  await expect(page.getByTestId('inline-command-proposal')).toHaveCount(0);
  await expect(editor).toHaveText('Version one');
  await page.evaluate(()=>window.mount('latex'));
});

test('polish dispatch errors and cancellation remain truthful and never change text', async () => {
  await page.evaluate(()=>{window.polishMode='error';window.mount('latex');});
  await selectFile('main.tex');
  const editor=page.getByTestId('production-latex-content');
  await editor.click();await page.keyboard.press('Meta+a');
  await page.getByTestId('inline-command-polish').click();
  await expect(page.getByTestId('production-latex-save-note')).toContainText('Model not configured');
  assert.equal(await page.evaluate(()=>window.polishListenerCount()),0);
  await page.evaluate(()=>{window.polishMode='pending';});
  await page.getByTestId('inline-command-polish').click();
  await expect.poll(()=>page.evaluate(()=>window.polishListenerCount())).toBe(1);
  await page.evaluate(()=>window.emitPolish('','run_cancelled'));
  await expect(page.getByTestId('production-latex-save-note')).toContainText('润色已取消');
  await expect(page.getByTestId('inline-command-proposal')).toHaveCount(0);
  await expect(editor).toHaveText('Version one');
  assert.equal(await page.evaluate(()=>window.polishListenerCount()),0);
});

test('file reading view retains unsaved Markdown drafts and line wrapping state', async () => {
  await page.evaluate(() => window.mount('file'));
  await page.getByTestId('file-preview-edit').click();
  const editor = page.getByTestId('file-preview-editor');
  await editor.fill('# Unsaved draft\n\n$y=x^2$');
  await page.getByTestId('file-preview-wrap').click();
  await expect(editor).toHaveAttribute('wrap', 'off');
  await page.getByTestId('file-preview-render').click();
  await expect(page.getByRole('heading', {name: 'Unsaved draft'})).toBeVisible();
  await expect(page.locator('.katex')).toHaveCount(1);
  await page.getByTestId('file-preview-render').click();
  await expect(editor).toHaveValue('# Unsaved draft\n\n$y=x^2$');
  await expect(editor).toHaveAttribute('wrap', 'off');
  await page.getByTestId('file-preview-save').click();
  await expect(page.getByTestId('file-preview-saved')).toBeVisible();
});

test('writing saves before compiling, previews and exports the result, and waits for cancellation', async () => {
  await page.evaluate(() => window.mount('latex'));
  await selectFile('main.tex');
  const editor = page.getByTestId('production-latex-content');
  const draft = '\\documentclass{article}\n\\begin{document}\nCurrent saved draft\n\\end{document}';
  await editor.fill(draft);
  await page.getByTestId('writing-compile').click();
  await expect(page.getByTestId('writing-compile-result')).toContainText('上次编译成功');
  assert.equal(await page.evaluate(() => window.compiles.at(-1).content), draft);
  await expect(page.getByTestId('latex-dirty-indicator')).toHaveText('已保存');
  await page.getByRole('button', {name: '预览 PDF', exact: true}).click();
  await expect(page.getByRole('region', {name: '编译 PDF 预览'}).locator('iframe')).toHaveAttribute('src', 'about:blank');
  await expect(page.getByText('项目已归档，仅可阅读。')).toHaveCount(0);
  assert.match(await page.evaluate(() => window.pdfRequests.at(-1).relativePath), /^\.roc-build\/latex\/.+\.pdf$/);
  await expect(editor).toContainText('Current saved draft');
  await page.getByTestId('writing-export').click();
  await expect(page.getByTestId('writing-export')).toBeEnabled();
  await expect(page.getByText('已导出至', {exact: false})).toHaveCount(0);
  await page.evaluate(() => {window.exportPath = '/chosen/manuscript.pdf';});
  await page.getByTestId('writing-export').click();
  await expect(page.getByText('已导出至 /chosen/manuscript.pdf')).toBeVisible();
  await audit();
  if (process.env.ROC_AUTHORING_SCREENSHOTS) await page.screenshot({path: join(process.env.ROC_AUTHORING_SCREENSHOTS, 'writing-compiled.png')});
  await page.evaluate(() => {window.compileMode = 'failed';});
  await page.getByTestId('writing-compile').click();
  await expect(page.getByTestId('writing-compile-result')).toHaveText('编译失败');
  const problems=page.getByTestId('writing-problems');
  await expect(page.getByTestId('writing-problems-toggle')).toHaveAttribute('aria-expanded','true');
  const bounds=await problems.boundingBox();
  assert(bounds.height>=160&&bounds.height<=240);
  assert((await page.getByTestId('production-latex-editor').boundingBox()).y<bounds.y);
  await page.getByTestId('writing-problems-toggle').focus();await page.keyboard.press('Enter');
  await expect(page.getByTestId('writing-problems-toggle')).toHaveAttribute('aria-expanded','false');
  assert((await problems.boundingBox()).height<80);
  await page.keyboard.press('Enter');
  await page.getByRole('button', {name: 'main.tex:3', exact: true}).click();
  await expect(page.locator('.cm-activeLine')).toHaveText('Current saved draft');
  await page.evaluate(() => {window.compileMode = 'pending';});
  await page.getByTestId('writing-compile').click();
  await page.getByTestId('writing-compile-cancel').click();
  await expect(page.getByTestId('writing-compile-cancel')).toHaveText('正在取消…');
  await expect(page.getByTestId('writing-compile')).toBeDisabled();
  await expect(page.getByTestId('writing-compile-result')).toHaveCount(0);
  await page.evaluate(() => window.finishCompile());
  await expect(page.getByTestId('writing-compile-result')).toHaveText('编译已取消');
  await expect(page.getByTestId('writing-compile')).toBeEnabled();
  await page.evaluate(() => {window.compileMode = 'ready';});
});

test('bottom problems retain drafts and readable locations in both themes and densities', async () => {
  await page.evaluate(()=>{window.compileMode='failed';window.mount('latex');});
  try {
    await page.getByTestId('writing-compile').click();
    await expect(page.getByTestId('writing-problems')).toBeVisible();
    await selectFile('notes.md');
    const editor=page.getByTestId('production-latex-content');
    await editor.fill('Uncommitted notes');
    await page.getByRole('button',{name:'main.tex:3',exact:true}).click();
    await expect(page.getByTestId('latex-unsaved')).toBeVisible();
    await page.getByTestId('latex-unsaved').getByRole('button',{name:'取消',exact:true}).click();
    await expect(editor).toHaveText('Uncommitted notes');
    await expect(page.getByTestId('latex-dirty-indicator')).toHaveText('未保存');
    for(const theme of ['light','dark'])for(const density of ['compact','comfortable'])for(const width of [1184,1280,1440]){
      await page.setViewportSize({width,height:800});
      await page.evaluate(({theme,density})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.density=density;},{theme,density});
      const panel=await page.getByTestId('writing-problems').boundingBox();
      assert(panel.height>=160&&panel.height<=240);
      await expect(page.getByRole('button',{name:'main.tex:3',exact:true})).toBeVisible();
      await audit();
    }
  } finally {await page.evaluate(()=>{window.compileMode='ready';window.mount('latex');});}
});

test('Git gives the diff more space without losing the commit draft or file selection', async () => {
  await page.evaluate(() => window.mount('git'));
  await expect(page.getByTestId('git-diff')).toContainText('new result');
  await expect(page.getByTestId('git-diff-stat')).not.toBeVisible();
  await page.getByTestId('git-commit-message').fill('Describe the research change');
  const before = await page.getByTestId('git-diff').boundingBox();
  await page.getByTestId('git-diff-focus').click();
  await expect(page.getByTestId('git-change-scroll')).not.toBeVisible();
  const after = await page.getByTestId('git-diff').boundingBox();
  assert(after.height > before.height + 100);
  await expect(page.getByTestId('git-commit-message')).toHaveValue('Describe the research change');
  await page.getByTestId('git-push').click();
  await expect(page.getByRole('alert')).toContainText('Remote is unavailable');
  await page.getByTestId('git-diff-focus').click();
  await expect(page.getByTestId('git-change-scroll')).toBeVisible();
  await page.getByText('变更统计', {exact: true}).click();
  await expect(page.getByTestId('git-diff-stat')).toBeVisible();
  await audit();
});

test('terminal clear preserves the connected PTY and still forwards subsequent input', async () => {
  await page.evaluate(() => window.mount('terminal'));
  await expect(page.getByTestId('terminal-view')).toHaveAttribute('data-phase', 'ready');
  await page.evaluate(() => window.emitOutput({sessionId: 'terminal-fixture', data: 'OLD OUTPUT\r\nready> '}));
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('OLD OUTPUT'));
  const before = await page.evaluate(() => ({creates: window.terminalCreates.length, writes: window.terminalInputs.length, closes: window.terminalCloses.length}));
  await page.getByTestId('terminal-clear').click();
  await page.waitForFunction(() => !document.querySelector('.xterm-rows')?.textContent.includes('OLD OUTPUT'));
  assert.deepEqual(await page.evaluate(() => ({creates: window.terminalCreates.length, writes: window.terminalInputs.length, closes: window.terminalCloses.length})), before);
  await page.keyboard.type('pwd');
  await page.waitForFunction(() => window.terminalInputs.map(item => item.data).join('').includes('pwd'));
  await page.evaluate(() => window.emitExit({sessionId: 'terminal-fixture', exitCode: 0}));
  await expect(page.getByTestId('terminal-clear')).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('已退出');
});

test('hidden terminal releases xterm DOM and reconnects with retained output without closing its PTY', async () => {
  await page.evaluate(() => window.mount('terminal'));
  await expect(page.getByTestId('terminal-view')).toHaveAttribute('data-phase', 'ready');
  const before = await page.evaluate(() => ({creates:window.terminalCreates.length,closes:window.terminalCloses.length,attaches:window.terminalAttaches.length}));
  await page.evaluate(() => window.setTerminalActive(false));
  await expect(page.locator('.xterm')).toHaveCount(0);
  await page.evaluate(() => window.emitOutput({sessionId:'terminal-fixture',data:'RETAINED WHILE HIDDEN\r\n'}));
  await page.evaluate(() => window.setTerminalActive(true));
  await expect(page.getByTestId('terminal-view')).toHaveAttribute('data-phase', 'ready');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('RETAINED WHILE HIDDEN'));
  assert.deepEqual(await page.evaluate(() => ({creates:window.terminalCreates.length,closes:window.terminalCloses.length})),{creates:before.creates,closes:before.closes});
  assert.equal(await page.evaluate(() => window.terminalAttaches.length),before.attaches+1);
  await page.getByTestId('terminal-end').click();
  await expect(page.getByTestId('terminal-end-confirm')).toBeVisible();
  await page.getByTestId('terminal-end-confirm').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.evaluate(() => window.terminalCloses.length),before.closes);
  await page.getByTestId('terminal-end').click();
  await page.getByTestId('terminal-end-confirm').getByRole('button',{name:'结束会话',exact:true}).click();
  await expect(page.getByTestId('terminal-view')).toHaveAttribute('data-phase','exited');
  await expect(page.getByTestId('terminal-end-confirm')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.terminalCloses.length),before.closes+1);
});

test('truncated terminal replay is explicit in the interface', async () => {
  await page.evaluate(() => {window.replayTruncated=true;window.mount('terminal');});
  await expect(page.getByTestId('terminal-replay-truncated')).toContainText('更早内容超出回放容量');
  await page.evaluate(() => {window.replayTruncated=false;window.unmount();});
});

test('tool surfaces retain usable content space and unclipped controls in both themes', async () => {
  for (const theme of ['light', 'dark']) for (const width of [440, 820, 1200]) {
    await page.setViewportSize({width, height: width === 440 ? 560 : 760});
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
    for (const mode of ['latex', 'file', 'git', 'terminal']) {
      await page.evaluate(mode => window.mount(mode), mode);
      if (mode === 'latex') {
        await selectFile('notes.md');
        await page.getByTestId('latex-toggle-preview').click();
        await expect(page.locator('.authoring-live-preview .katex')).toHaveCount(1);
        const content = await page.getByTestId('latex-source-editor').boundingBox();
        assert(content.width > 180 && content.height >= 160);
      } else if (mode === 'file') {
        await page.getByTestId('file-preview-render').click();
        await expect(page.locator('.tools-markdown-preview .katex')).toHaveCount(1);
      } else if (mode === 'git') {
        await expect(page.getByTestId('git-diff')).toBeVisible();
      } else await expect(page.getByTestId('terminal-clear')).toBeEnabled();
      await audit();
      await page.getByRole('button').first().hover();
      await audit();
      if (process.env.ROC_AUTHORING_SCREENSHOTS) {
        await page.screenshot({path: join(process.env.ROC_AUTHORING_SCREENSHOTS, theme + '-' + width + '-' + mode + '.png')});
      }
    }
  }
});
