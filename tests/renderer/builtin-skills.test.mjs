import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';
import { buildViteRenderer } from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-builtin-skills-ui-'));
  await buildViteRenderer({ directory, script: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SWRConfig } from 'swr';
    import { LazyMotion, domMax } from 'motion/react';
    import { useSkills } from './src/renderer/management/use-skills';
    import { SkillsSection } from './src/renderer/management/sections/SkillsSection';

    const ok = data => ({ ok: true, data });
    const source = { id: 'demo', displayName: 'Demo Skills', repo: 'demo/skills', ref: 'main',
      license: 'Apache-2.0', bundledCommit: '12345678', installedCommit: '12345678',
      skillIds: ['demo-writing'], lastCheckedAt: null, lastError: null };
    const status = { schemaVersion: 1, autoUpdate: false, updating: false, lastCheckedAt: null, sources: [source] };
    let content = 'Before reinstall';
    let entries = ['SKILL.md'];
    window.restoreCount = 0;
    window.listCount = 0;
    const client = { api: { skills: {
      list: async () => { window.listCount++; return ok([{ id: 'demo-writing', name: 'demo-writing',
        description: 'Demo.', path: '/tmp/roc/skills/demo-writing', enabled: false, status: 'ready',
        origin: 'builtin', sourceId: 'demo', upstreamCommit: '12345678' }]); },
      builtinStatus: async () => ok(status),
      onUpdated: () => () => {},
      builtinRestore: async () => {
        window.restoreCount++;
        return await new Promise(resolve => { window.finishRestore = success => {
          if (success) { content = 'Restored content'; entries = ['SKILL.md', 'references']; }
          resolve(success ? ok(status) : { ok: false, error: { message: 'Snapshot checksum failed' } });
        }; });
      },
      listFiles: async () => ok({ id: 'demo-writing', rootPath: '/tmp/roc/skills/demo-writing',
        entries: entries.map(name => ({ name, relativePath: name, type: name === 'references' ? 'directory' : 'file' })), truncated: false }),
      readFile: async () => ok({ id: 'demo-writing', relativePath: 'SKILL.md', kind: 'text', content, sizeBytes: content.length, truncated: false })
    } } };
    function Harness() {
      const store = useSkills(client);
      return <><SkillsSection store={store}/>
        <button data-testid="probe-open-preview" onClick={() => store.openFile('SKILL.md')}>Read</button>
        <output data-testid="probe-preview">{store.preview?.content}</output>
        <output data-testid="probe-entries">{store.entries.map(entry => entry.name).join(',')}</output>
      </>;
    }
    createRoot(document.getElementById('root')).render(
      <SWRConfig value={{provider: () => new Map()}}>
        <LazyMotion features={domMax} strict><Harness/></LazyMotion>
      </SWRConfig>
    );
  `, style: 'body{margin:0;padding:16px}' });
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByTestId('mgmt-skills-builtin-restore-demo')).toBeVisible();
});

after(async () => {
  try { await app?.close(); } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
});

test('same-commit reinstall reports success, refreshes files, and clears success on failed retry', async () => {
  await page.getByTestId('probe-open-preview').click();
  await expect(page.getByTestId('probe-preview')).toHaveText('Before reinstall');
  const button = page.getByTestId('mgmt-skills-builtin-restore-demo');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveText('安装中…');
  await expect(button).toBeDisabled();
  await page.evaluate(() => window.finishRestore(true));
  await expect(page.getByTestId('mgmt-skills-builtin-restored')).toContainText('Demo Skills');
  await expect(page.getByTestId('mgmt-skills-builtin-restored')).toContainText('1 个技能');
  await expect(page.getByTestId('probe-preview')).toHaveText('Restored content');
  await expect(page.getByTestId('probe-entries')).toContainText('references');
  await expect(page.getByTestId('mgmt-skill-enabled-demo-writing')).not.toBeChecked();
  assert.ok(await page.evaluate(() => window.listCount >= 2));

  await button.click();
  await expect(page.getByTestId('mgmt-skills-builtin-check')).toBeDisabled();
  await expect(page.getByTestId('mgmt-skills-builtin-restored')).toHaveCount(0);
  await page.evaluate(() => window.finishRestore(false));
  await expect(page.getByTestId('mgmt-skills-builtin-action-error')).toHaveText('Snapshot checksum failed');
  await expect(button).toBeEnabled();
  await expect(page.getByTestId('mgmt-skills-builtin-restored')).toHaveCount(0);
});
