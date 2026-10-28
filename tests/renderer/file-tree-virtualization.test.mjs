import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

let tempDir;
let app;
let page;
const rendererErrors = [];

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-file-tree-virtualization-'));
  await esbuild.build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { FileTreeView } from './src/renderer/canvas/files/FileTreeView';

        const workspacePath = '/test/workspace';
        const ok = data => ({ok: true, data});
        const rootEntries = [
          {name: 'broken', relativePath: 'broken', type: 'directory', size: 0, updatedAt: '2026-01-01T00:00:00.000Z'},
          ...Array.from({length: 300}, (_, index) => {
            const name = 'file-' + String(index).padStart(3, '0') + '.txt';
            return {name, relativePath: name, type: 'file', size: 1, updatedAt: '2026-01-01T00:00:00.000Z'};
          })
        ];
        const client = {api: {
          files: {
            listTree: async ({relativePath}) => {
              if (relativePath === 'broken') {
                return {ok: false, error: {message: 'Simulated directory failure'}};
              }
              return ok({
                workspacePath,
                relativePath,
                entries: relativePath === '' ? rootEntries : [],
                truncated: false
              });
            }
          },
          workspace: {onChanged: () => () => {}}
        }};
        const root = createRoot(document.getElementById('root'));
        window.openedFiles = [];
        window.mountFileTree = () => flushSync(() => root.render(
          React.createElement(FileTreeView, {
            client,
            workspacePathKey: workspacePath,
            projectId: 'virtualized-tree-test',
            selectedPath: null,
            onOpenFile: relativePath => window.openedFiles.push(relativePath)
          })
        ));
      `,
      resolveDir: process.cwd(),
      loader: 'jsx'
    },
    outfile: join(tempDir, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent'
  });
  writeFileSync(join(tempDir, 'index.html'), `
    <style>
      html, body, #root { margin: 0; height: 100%; }
      #root { width: 480px; height: 360px; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
      [data-testid="file-tree"] { display: flex; flex-direction: column; height: 100%; min-height: 0; }
      [data-testid="file-tree-scroll"] { position: relative; display: block; height: 320px; min-height: 0; overflow-y: auto; }
      [data-testid="file-tree-scroll"] > [role="group"] { position: relative; }
      [data-testid^="file-tree-row-"] { display: flex; box-sizing: border-box; height: 24px; min-height: 24px; }
      [role="alert"] { min-height: 20px; margin: 0; }
    </style>
    <div id="root"></div>
    <script src="renderer.js"></script>
  `);
  writeFileSync(join(tempDir, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(join(tempDir, 'data'))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({show: false, width: 900, height: 700});
      window.loadFile(${JSON.stringify(join(tempDir, 'index.html'))});
    });
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(tempDir, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.waitForFunction(() => typeof window.mountFileTree === 'function');
  await page.evaluate(() => window.mountFileTree());
  await page.getByTestId('file-tree-scroll').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="file-tree-virtualizer-loading"]'));
});

after(async () => {
  try {
    await app?.close();
  } finally {
    if (tempDir !== undefined) rmSync(tempDir, {recursive: true, force: true});
  }
  assert.deepEqual(rendererErrors, [], 'the virtualized file tree must not throw in the renderer');
});

test('virtualized file tree keeps active focus through scrolling and measures directory errors', async () => {
  const tree = page.getByTestId('file-tree-scroll');
  await tree.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => {
    const treeElement = document.querySelector('[data-testid="file-tree-scroll"]');
    const activeId = treeElement?.getAttribute('aria-activedescendant');
    const activeItem = activeId ? document.getElementById(activeId) : null;
    return activeItem?.textContent?.trim() === 'file-299.txt' &&
      document.querySelector('[data-testid="file-tree-row-file-299.txt"]') !== null;
  });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'file-tree-scroll');
  assert.deepEqual(await page.evaluate(() => {
    const treeElement = document.querySelector('[data-testid="file-tree-scroll"]');
    const activeId = treeElement?.getAttribute('aria-activedescendant');
    const activeItem = activeId ? document.getElementById(activeId) : null;
    return {
      activeName: activeItem?.textContent?.trim(),
      position: activeItem?.getAttribute('aria-posinset'),
      setSize: activeItem?.getAttribute('aria-setsize')
    };
  }), {activeName: 'file-299.txt', position: '301', setSize: '301'});

  await tree.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid="file-tree-row-file-299.txt"]'));
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'file-tree-scroll');
  assert.equal(await page.evaluate(() => {
    const treeElement = document.querySelector('[data-testid="file-tree-scroll"]');
    const activeId = treeElement?.getAttribute('aria-activedescendant');
    return activeId === null ? null : document.getElementById(activeId)?.textContent?.trim();
  }), 'file-299.txt');

  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => {
    const treeElement = document.querySelector('[data-testid="file-tree-scroll"]');
    const activeId = treeElement?.getAttribute('aria-activedescendant');
    const activeItem = activeId ? document.getElementById(activeId) : null;
    return activeItem?.textContent?.trim() === 'file-298.txt' &&
      document.querySelector('[data-testid="file-tree-row-file-298.txt"]') !== null;
  });
  assert.deepEqual(await page.getByTestId('file-tree-row-file-298.txt').evaluate((row) => ({
    position: row.getAttribute('aria-posinset'),
    setSize: row.getAttribute('aria-setsize')
  })), {position: '300', setSize: '301'});

  await page.keyboard.press('Home');
  await page.waitForFunction(() => {
    const treeElement = document.querySelector('[data-testid="file-tree-scroll"]');
    const activeId = treeElement?.getAttribute('aria-activedescendant');
    return activeId !== null && document.getElementById(activeId)?.textContent?.trim() === 'broken';
  });
  await page.keyboard.press('Enter');
  const error = page.getByRole('alert').filter({hasText: 'Simulated directory failure'});
  await error.waitFor();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => {
    const treeElement = document.querySelector('[data-testid="file-tree-scroll"]');
    const activeId = treeElement?.getAttribute('aria-activedescendant');
    const activeItem = activeId ? document.getElementById(activeId) : null;
    return activeItem?.textContent?.trim() === 'file-000.txt' &&
      document.querySelector('[data-testid="file-tree-row-file-000.txt"]') !== null;
  });
  assert.equal(await error.count(), 1);
  assert.equal(await page.evaluate(() => {
    const alert = document.querySelector('[role="alert"]');
    const row = document.querySelector('[data-testid="file-tree-row-file-000.txt"]');
    return alert !== null && row !== null && row.getBoundingClientRect().top >= alert.getBoundingClientRect().bottom - 1;
  }), true, 'the next row follows the measured directory error without overlap');
});
