import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { navigate } from './lib/gate-harness.mjs';

// Run after pnpm build with the pinned complete model pack installed in .runtime/research-models.
// Uses the real normal-mode app, IPC, worker, OCR models, and reader with disposable user data.
// Missing models or any content mismatch fails; there is no degraded pass path.
mkdirSync(resolve('.artifacts'), { recursive: true });
const artifactDir = mkdtempSync(resolve('.artifacts/parser-content-'));
const fixtureRoot = mkdtempSync(join(tmpdir(), 'roc-parser-content-'));
const dataRoot = join(fixtureRoot, 'data');
const workspacePath = join(fixtureRoot, 'workspace');
mkdirSync(workspacePath, { recursive: true });
const sourcePath = join(workspacePath, 'paper.pdf');
copyFileSync('tests/smoke/lib/assets/p5-paper.pdf', sourcePath);
const rendererErrors = [];
const checks = [];
let app;
let page;
let failure;
const unwrap = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const record = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const canonicalFormula = (text) => text.replace(/\s+/gu, '')
  .replace(/\\[cd]frac/gu, '\\frac')
  .replace(/([_^])\{([a-zA-Z0-9]|\\[a-zA-Z]+)\}/gu, '$1$2');

try {
  const env = { ...process.env, ROC_DATA_ROOT: dataRoot };
  delete env.ROC_SMOKE;
  delete env.ROC_SMOKE_API_KEY;
  app = await electron.launch({ args: [resolve('dist/main/index.js'), `--user-data-dir=${join(dataRoot, 'chromium')}`], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') rendererErrors.push(message.text()); });
  await page.getByTestId('portal').waitFor();
  const models = unwrap(await page.evaluate(() => window.roc.research.selectModels({ pack: 'complete' })));
  assert.equal(models.ready, true, 'Install the pinned complete research model pack before running this gate');
  record('complete models ready');
  const project = unwrap(await page.evaluate((workspacePath) => window.roc.research.createProject({
    title: 'Parser content regression', description: 'Disposable real-model fixture', workspacePath
  }), workspacePath));
  await navigate(page, `page=research&project=${project.id}&view=literature`);
  await page.getByTestId('literature-hub').waitFor();
  const document = unwrap(await page.evaluate(({ sourcePath, projectId }) => window.roc.research.importDocument({
    target: 'new-item', sourcePath, title: 'PDF table and formula regression', citationKey: 'parserFixture', projectId
  }), { sourcePath, projectId: project.id }));
  record('PDF imported through real IPC');
  await page.getByTestId('literature-refresh').click();
  await page.getByTestId('sidebar-tab-literature').click();
  await page.getByTestId('sidebar-panel-literature').getByTestId(`literature-row-${document.libraryItemId}`).click();
  await page.getByTestId('paper-reader').waitFor();
  await page.getByTestId('reader-parse-tier').selectOption('complete');
  await page.getByTestId('reader-start-parse').click();
  await expect(page.getByTestId('reader-document-status')).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  record('complete parse started in UI and reached ready');
  const current = unwrap(await page.evaluate((documentId) => window.roc.research.getDocument({ documentId }), document.id));
  const request = { projectId: project.id, documentId: document.id, parseId: current.currentParseId,
    sourceHash: document.sourceHash, parseHash: null };
  const parsed = unwrap(await page.evaluate((input) => window.roc.research.getDocumentContent(input), request));
  writeFileSync(join(artifactDir, 'parsed.json'), JSON.stringify(parsed, null, 2));
  const expectedTable = '| Method | Accuracy | F1 |\n| --- | --- | --- |\n| Baseline | 0.812 | 0.804 |\n| Ours | 0.897 | 0.891 |';
  const table = parsed.content.blocks.find((block) => block.kind === 'table');
  assert.equal(table?.text, expectedTable);
  record('all nine table cells and row/column assignments match the PDF');
  const formula = parsed.content.blocks.find((block) => block.kind === 'formula');
  const expectedFormula = String.raw`\mathcal{L}(\theta)=\frac{1}{N}\sum_{i=1}^{N}(y_i-f_\theta(x_i))^2+\lambda\|\theta\|_2^2`;
  assert.ok(canonicalFormula(formula?.text ?? '').includes(canonicalFormula(expectedFormula)), formula?.text);
  record('full formula matches numerator, denominator, limits, powers, and regularizer');
  const preview = unwrap(await page.evaluate((input) => window.roc.research.previewDocument(input), request));
  writeFileSync(join(artifactDir, 'preview.json'), JSON.stringify(preview, null, 2));
  assert.equal(preview.coordinates.pages.length, 1);
  record('parse publishes verified PDF coordinates');
  // The reader switches from the original PDF to parsed blocks when publication completes.
  await page.getByTestId('reader-block-table').waitFor();
  await expect(page.getByTestId('reader-block-table')).toContainText(expectedTable);
  await expect(page.getByTestId('reader-block-formula')).toContainText(formula.text);
  await page.getByTestId('reader-block-formula').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'reader-formula.png') });
  await page.getByTestId('reader-block-table').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'reader-content.png') });
  record('reader displays the actual corrected table and formula');
  assert.deepEqual(rendererErrors, []);
  record('no renderer errors');
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: join(artifactDir, 'failure.png') }).catch(() => {});
  if (existsSync(join(dataRoot, 'logs'))) cpSync(join(dataRoot, 'logs'), join(artifactDir, 'logs'), { recursive: true });
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(artifactDir, 'report.json'), JSON.stringify({ passed: !failure, checks, rendererErrors,
    error: failure?.stack ?? null }, null, 2));
  if (app) await app.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
  console.log(`Report: ${artifactDir}`);
}
