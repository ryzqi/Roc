import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

test('clip audit detects clipped and hover shadows and accepts sufficient space', async () => {
  const source = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'roc-clip-audit-'));
  let app;
  try {
    await writeFile(join(directory, 'index.html'), `<!doctype html><style>
      body { margin: 48px; }
      #frame { overflow: hidden; width: 160px; height: 160px; padding: 4px; }
      #surface { width: 80px; height: 80px; box-shadow: 0 0 12px black; }
      #surface.hover { box-shadow: none; }
      #surface.hover:hover { box-shadow: 0 0 12px black; }
    </style><div id="frame"><div id="surface"></div></div>`);
    await writeFile(join(directory, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
      app.whenReady().then(() => new BrowserWindow({ show: false, width: 800, height: 600 })
        .loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
    app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
    const page = await app.firstWindow();
    await page.locator('#surface').waitFor();
    const audit = () => page.evaluate(code => (0, eval)(code)({ viewport: true }), source);

    const clipped = await audit();
    assert.equal(clipped.ok, false);
    assert.ok(clipped.cut > 0);
    assert.ok(clipped.issues.some(issue => issue.kind === 'box-shadow' && issue.level === 'cut'));

    await page.locator('#surface').evaluate(element => { element.style.boxShadow = '0 0 12px rgb(255, 0, 0)'; });
    const red = await audit();
    assert.equal(red.cut, clipped.cut, 'zero blue channel does not make an opaque color transparent');

    for (const color of ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.0)', 'rgb(0 0 0 / 0)', 'rgb(0 0 0 / 0%)']) {
      await page.locator('#surface').evaluate((element, color) => { element.style.boxShadow = `0 0 12px ${color}`; }, color);
      const transparent = await audit();
      assert.equal(transparent.cut, 0, color);
      assert.equal(transparent.hidden, 0, color);
    }
    await page.locator('#surface').evaluate(element => { element.style.removeProperty('box-shadow'); });

    await page.locator('#frame').evaluate(element => { element.style.padding = '24px'; });
    const clear = await audit();
    assert.equal(clear.ok, true);
    assert.equal(clear.cut, 0);

    await page.evaluate(() => {
      document.querySelector('#frame').style.padding = '4px';
      document.querySelector('#surface').className = 'hover';
    });
    const hover = await audit();
    assert.ok(hover.cut > 0);
    assert.ok(hover.issues.some(issue => issue.kind === 'hover box-shadow' && issue.level === 'cut'));

    await page.locator('#frame').evaluate(element => { element.style.padding = '0'; });
    const hidden = await audit();
    assert.equal(hidden.cut, 0);
    assert.ok(hidden.hidden > 0, 'fully hidden edges remain distinct from partial cuts');
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
