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
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {LatexPanel} from './src/renderer/latex/LatexPanel';
    import {FilePreview} from './src/renderer/canvas/files/FilePreview';
    import {GitPanel} from './src/renderer/canvas/git/GitPanel';
    import {TerminalSessionView} from './src/renderer/canvas/terminal/TerminalView';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    const ok = data => ({ok: true, data});
    const contents = {'main.tex': ${JSON.stringify(formula)}, 'notes.md': ${JSON.stringify(markdown)}};
    const snapshot = {id: 'terminal-fixture', cwd: '/synthetic', shell: '/bin/zsh', status: 'running', exitCode: null};
    window.writes = []; window.inlineCommands = []; window.terminalCreates = []; window.terminalInputs = []; window.terminalCloses = [];
    window.addEventListener('roc:inline-selection-command', event => window.inlineCommands.push(event.detail));
    window.compiles = []; window.exports = []; window.pdfRequests = []; window.compileMode = 'ready'; window.exportPath = null;
    window.fileListMode = 'ready'; window.fileScans = 0;
    const client = {api: {
      workspace: {onChanged: () => () => {}},
      files: {
        listTree: async () => {window.fileScans++;
          return window.fileListMode === 'error' ? {ok:false,error:{message:'Scan unavailable'}} :
            ok({relativePath: '', truncated: window.fileListMode === 'partial', entries: window.fileListMode === 'empty' ? [] : Object.keys(contents).map(name =>
              ({name, relativePath: name, type: 'file', size: contents[name].length, updatedAt: '2026-11-12T00:00:00.000Z'}))});},
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
        onOutput: callback => {window.emitOutput = callback; return () => {window.emitOutput = null;};},
        onExit: callback => {window.emitExit = callback; return () => {window.emitExit = null;};},
        createSession: async request => {window.terminalCreates.push(request); return ok({...snapshot, ...request});},
        resize: async request => ok({...snapshot, ...request}),
        writeInput: async request => {window.terminalInputs.push(request); return ok(true);},
        closeSession: async request => {window.terminalCloses.push(request); return ok(true);}
      }
    }};
    const scope = {client, projectId: 'fixture', workspacePath: '/synthetic', writable: true,
      workspaceStatus: 'ready', workspaceError: null, openFileInCanvas: () => {}, rebindWorkspace: () => {}};
    const root = createRoot(document.getElementById('root'));
    let epoch = 0;
    window.unmount = () => flushSync(() => root.render(null));
    window.mount = mode => {
      window.unmount();
      const child = mode === 'latex' ? <LatexPanel /> : mode === 'file' ?
        <FilePreview client={client} projectId="fixture" workspacePath="/synthetic" relativePath="notes.md" writable /> :
        mode === 'git' ? <GitPanel client={client} workspacePath="/synthetic" writable layout="drawer" /> :
        <TerminalSessionView client={client} workspacePath="/synthetic" writable />;
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
  await page.getByTestId('inline-command-polish').click();
  const dispatched = await page.evaluate(() => window.inlineCommands.at(-1));
  assert.equal(dispatched.action, 'polish');
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
