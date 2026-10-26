import { _electron as electron, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSmokePaths, seedSmokeSkillSource, seedSmokeWorkspace } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';
import { navigate } from './lib/gate-harness.mjs';

const artifact = resolve('.artifacts/ui-ux', process.env.ROC_UI_PHASE ?? 'unsaved');
mkdirSync(artifact, { recursive: true });
const paths = await createSmokePaths();
seedSmokeWorkspace(paths.workspaceRoot, paths.remoteRoot);
seedSmokeSkillSource(paths.skillSourceRoot);
const main = join(paths.workspaceRoot, 'main.tex');
writeFileSync(main, '\\documentclass{article}\n\\begin{document}\nOriginal\n\\end{document}\n');
writeFileSync(join(paths.workspaceRoot, 'refs.bib'), '@article{example, title={Example}}\n');
const results = [];
const errors = [];
const audits = [];
const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
let app;
async function check(name, action) { await action(); results.push(name); console.log(`PASS ${name}`); }
try {
  app = await electron.launch({ executablePath: target.executablePath, args: target.launchArgs, env: {
    ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: paths.dataRoot, ROC_SMOKE_API_KEY: 'smoke-test-key'
  } });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('roc-app').waitFor();
  const project = await page.evaluate(async workspacePath => window.roc.research.createProject({ title: 'UI acceptance', description: 'UI UX acceptance project', workspacePath }), paths.workspaceRoot);
  console.log('fixture', paths.dataRoot);
  if (!project.ok) throw new Error(project.error.message);
  await navigate(page, `page=research&project=${project.data.id}&view=latex`);
  async function audit(state) {
    if (!process.env.ROC_CLIP_AUDIT) return;
    const source = readFileSync(process.env.ROC_CLIP_AUDIT, 'utf8');
    const result = await page.evaluate(`(${source})({ root: '[data-testid="production-latex"]', viewport: true })`);
    audits.push({ state, result }); expect(result.cut).toBe(0);
  }
  const editor = page.getByTestId('production-latex-content');
  const modal = page.getByTestId('latex-unsaved');
  const file = name => page.getByTestId(`production-latex-file-${name}`);
  await file('main.tex').click();
  await expect(editor).toHaveText(/Original/);
  await check('Cancel file switch keeps draft and focus', async () => {
    await editor.fill('unsaved draft'); await file('refs.bib').click();
    await expect(modal).toBeVisible(); await modal.getByRole('button', { name: '取消', exact: true }).click();
    await expect(modal).toHaveCount(0); await expect(editor).toHaveText('unsaved draft');
    await expect(file('refs.bib')).toBeFocused();
  });
  await check('Save and continue writes exact content before switching', async () => {
    await file('refs.bib').click(); await modal.getByRole('button', { name: '保存并继续' }).click();
    await expect(editor).toHaveText(/@article/);
    expect(readFileSync(main, 'utf8')).toBe('unsaved draft');
  });
  await check('Discard switches without writing', async () => {
    await editor.fill('discard me'); await file('main.tex').click();
    await modal.getByRole('button', { name: '放弃修改', exact: true }).click();
    await expect(editor).toHaveText('unsaved draft');
    expect(readFileSync(join(paths.workspaceRoot, 'refs.bib'), 'utf8')).toContain('@article');
  });
  await check('Command-S saves and clears dirty state', async () => {
    await editor.fill('keyboard save'); await editor.press('Meta+s');
    await expect(page.getByTestId('production-latex-state')).toContainText('与磁盘一致');
    expect(readFileSync(main, 'utf8')).toBe('keyboard save');
  });
  if (process.env.ROC_UI_PHASE === 'editor') {
    await check('Editor fills available height with line numbers and syntax', async () => {
      await editor.fill('\\section{Introduction}\nSome text');
      await expect(page.locator('.cm-gutterElement').filter({ hasText: '2' }).first()).toBeVisible();
      expect(await page.locator('.cm-content span').count()).toBeGreaterThan(0);
      const bounds = await page.getByTestId('latex-source-editor').boundingBox();
      expect(bounds.height).toBeGreaterThan(300);
      await audit('default'); await page.getByTestId('production-latex-save').hover(); await audit('hover');
    });
    await check('Native editor search and replace opens through keyboard', async () => {
      await editor.click(); await page.keyboard.press('Meta+f');
      await expect(page.locator('.cm-search')).toBeVisible(); await audit('search expanded');
      await page.locator('.cm-search input[name=search]').fill('Some');
      await page.locator('.cm-search input[name=replace]').fill('Replaced');
      await page.locator('.cm-search button[name=replaceAll]').click();
      await expect(editor).toContainText('Replaced text');
      await page.keyboard.press('Escape'); await audit('final');
      await page.screenshot({ path: join(artifact, 'editor.png') });
    });
  }
  if (process.env.ROC_UI_PHASE === 'layout') {
    await check('Focus enlarges canvas and restores previous geometry', async () => {
      const sidebar = await page.getByTestId('sidebar-column').boundingBox();
      const canvas = await page.getByTestId('canvas-column').boundingBox();
      await editor.fill('layout draft');
      await page.getByTestId('layout-preset-focus').click();
      await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
      await expect(page.getByTestId('assistant-column')).toHaveCount(0);
      expect((await page.getByTestId('canvas-column').boundingBox()).width).toBeGreaterThan(canvas.width);
      await expect(editor).toHaveText('layout draft');
      await page.screenshot({ path: join(artifact, 'focus.png') });
      await page.getByTestId('layout-preset-normal').click();
      expect((await page.getByTestId('sidebar-column').boundingBox()).width).toBe(sidebar.width);
      expect((await page.getByTestId('canvas-column').boundingBox()).width).toBe(canvas.width);
    });
    await check('Collaboration opens assistant, normal restores prior visibility', async () => {
      await page.getByTestId('layout-preset-collaboration').click();
      await expect(page.getByTestId('assistant-column')).toBeVisible();
      expect((await page.getByTestId('canvas-column').boundingBox()).width).toBeGreaterThanOrEqual(360);
      await page.getByTestId('layout-preset-normal').click();
      await expect(page.getByTestId('assistant-column')).toHaveCount(0);
    });
    await check('Focus shortcut toggles without changing document', async () => {
      await editor.click(); await page.keyboard.press('Meta+Shift+f');
      await expect(page.getByTestId('layout-preset-focus')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Meta+Shift+f');
      await expect(page.getByTestId('layout-preset-normal')).toHaveAttribute('aria-pressed', 'true');
      await expect(editor).toHaveText('layout draft');
    });
  }
  await check('Failed save retains draft and blocks navigation', async () => {
    await editor.fill('must survive failed write');
    renameSync(main, `${main}.bak`); mkdirSync(main);
    await file('refs.bib').click(); await modal.getByRole('button', { name: '保存并继续' }).click();
    await expect(modal.getByRole('alert')).toBeVisible(); await expect(editor).toHaveText('must survive failed write');
    await page.screenshot({ path: join(artifact, 'save-error.png') });
    await modal.getByRole('button', { name: '取消', exact: true }).click();
  });
  await check('Canvas navigation cancelled keeps route and draft', async () => {
    await navigate(page, `page=research&project=${project.data.id}&view=literature`);
    await expect(modal).toBeVisible(); await modal.getByRole('button', { name: '取消', exact: true }).click();
    await expect(editor).toHaveText('must survive failed write'); expect(page.url()).toContain('view=latex');
  });
  await check('Window unload is blocked until decision', async () => {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.reload(); });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    await expect(editor).toHaveText('must survive failed write');
  });
  await check('Project leave requires explicit discard', async () => {
    await navigate(page, 'page=research'); await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: '放弃修改', exact: true }).click();
    await expect(page.getByTestId('portal-column')).toBeVisible();
  });
  expect(errors).toEqual([]);
  writeFileSync(join(artifact, 'report.json'), JSON.stringify({ passed: true, results, errors, audits, command: 'node scripts/verify-ui-ux.mjs', cwd: process.cwd(), platform: process.platform, dataRoot: paths.dataRoot }, null, 2));
} catch(error) {
  writeFileSync(join(artifact, 'report.json'), JSON.stringify({ passed: false, results, errors, error: String(error) }, null, 2));
  throw error;
} finally {
  if (app) await app.close();
}
