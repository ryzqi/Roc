import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {build as buildStyles} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';

let directory, app, page;
const errors = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-text-selection-'));
  const styles = await buildStyles({configFile: false, root: process.cwd(), plugins: [tailwindcss()],
    logLevel: 'silent', build: {write: false,
      rolldownOptions: {input: join(process.cwd(), 'src/renderer/styles/index.css')}}});
  const stylesheet = styles.output.find(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  assert.ok(stylesheet, 'renderer stylesheet must be emitted');
  await writeFile(join(directory, 'app.css'), stylesheet.source);
  await writeFile(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <body><main style="padding:32px">
      <h1 id="title">研究项目标题</h1>
      <p id="message">这段消息支持选中复制。</p>
      <div id="error" role="alert">连接失败，请检查服务地址。</div>
      <div id="path">/workspace/研究项目/results.csv</div>
      <table><tbody><tr><td id="cell">实验结果 42</td></tr></tbody></table>
      <pre><code id="code">  const value = 42;  </code></pre>
      <button id="button"><span>运行任务</span></button>
      <div role="button" tabindex="0" id="role-button"><span>打开项目</span></div>
      <select id="select"><option>默认模型</option></select>
      <details><summary id="summary">工具详情</summary>执行成功</details>
      <div id="drag" class="drag-region">窗口拖拽区</div>
      <div id="divider" class="select-none" role="separator">调整分栏</div>
      <div class="select-none"><p id="opt-in" data-selectable="true">允许复制的内容</p></div>
      <textarea id="input">可编辑草稿</textarea>
      <div id="editable" contenteditable="true">可编辑正文</div>
    </main></body></html>`);
  await build({stdin: {contents: `
    import {app, BrowserWindow, Menu, clipboard} from 'electron';
    import {buildApplicationMenuTemplate} from './src/main/application-menu';
    import {createNativeContextMenuHandler} from './src/main/native-context-menu';
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(() => {})));
      const window = new BrowserWindow({show: false, width: 900, height: 650});
      window.webContents.on('context-menu', createNativeContextMenuHandler({
        buildFromTemplate: template => {
          globalThis.contextTemplate = template;
          return {popup: () => {}};
        },
        writeText: text => clipboard.writeText(text)
      }));
      window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });
  `, resolveDir: process.cwd(), loader: 'ts'}, outfile: join(directory, 'main.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'});
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#message').waitFor();
  await app.evaluate(async ({clipboard, ClipboardItem}) => {
    const items = await clipboard.read();
    globalThis.selectionTestClipboard = await Promise.all(items.filter(item => item.types.length > 0).map(async item => new ClipboardItem(
      Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))
    )));
  });
});

after(async () => {
  try {
    if (app) await app.evaluate(async ({clipboard}) => {
      if (globalThis.selectionTestClipboard?.length) await clipboard.write(globalThis.selectionTestClipboard);
      else if (globalThis.selectionTestClipboard) clipboard.clear();
    });
  } finally {
    try {await app?.close();} finally {if (directory) await rm(directory, {recursive: true, force: true});}
  }
  assert.deepEqual(errors, []);
});

async function dragSelect(selector) {
  const bounds = await page.locator(selector).evaluate(element => {
    window.getSelection().removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
  });
  await page.mouse.move(bounds.x, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width, bounds.y + bounds.height / 2, {steps: 12});
  await page.mouse.up();
  return page.evaluate(() => window.getSelection().toString());
}

test('read-only text supports mouse selection in both themes', async () => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const id of ['title', 'message', 'error', 'path', 'cell', 'code', 'opt-in']) {
      const text = await page.locator(`#${id}`).textContent();
      assert.equal(await dragSelect(`#${id}`), text, `${theme}: ${id} must support mouse selection`);
    }
  }
});

test('controls and drag handles stay non-selectable while editors allow selection', async () => {
  for (const id of ['button', 'role-button', 'select', 'summary', 'drag', 'divider']) {
    assert.equal(await page.locator(`#${id}`).evaluate(element => getComputedStyle(element).userSelect), 'none', id);
  }
  for (const id of ['input', 'editable', 'opt-in']) {
    assert.equal(await page.locator(`#${id}`).evaluate(element => getComputedStyle(element).userSelect), 'text', id);
  }
});

test('native copy shortcut copies selected read-only text and leaves drafts intact', async () => {
  const text = await page.locator('#message').textContent();
  assert.equal(await dragSelect('#message'), text);
  await app.evaluate(({clipboard}) => clipboard.writeText('copy shortcut sentinel'));
  await page.keyboard.press('Meta+c');
  await expect.poll(() => app.evaluate(({clipboard}) => clipboard.readText())).toBe(text);
  const input = page.locator('#input');
  await input.focus();
  await input.press('Meta+a');
  await input.press('Meta+c');
  await expect.poll(() => app.evaluate(({clipboard}) => clipboard.readText())).toBe('可编辑草稿');
  assert.equal(await input.inputValue(), '可编辑草稿');
});

test('native context copy preserves selected code whitespace', async () => {
  const text = await page.locator('#code').textContent();
  await page.locator('#code').evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  await page.locator('#code').click({button: 'right'});
  await expect.poll(() => app.evaluate(() => globalThis.contextTemplate?.[0]?.label)).toBe('复制所选内容');
  await app.evaluate(() => globalThis.contextTemplate[0].click());
  await expect.poll(() => app.evaluate(({clipboard}) => clipboard.readText())).toBe(text);
});
