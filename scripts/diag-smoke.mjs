import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { projectRoot } from './lib/electron-version.mjs';

const appPath = process.argv[2];
const runRoot = mkdtempSync(join(projectRoot, '.runtime', 'diag-'));
const app = await electron.launch({
  executablePath: join(appPath, 'Contents', 'MacOS', 'Roc'),
  args: [`--user-data-dir=${join(runRoot, 'chromium')}`],
  env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: join(runRoot, 'data'), ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 180000
});
console.log('launched');
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const windows = app.windows();
  console.log(`t=${i + 1}s windows=${windows.length}`);
  if (windows.length > 0) break;
}
try {
  const page = await app.firstWindow();
  console.log('firstWindow ok');
  await page.locator('[data-testid="roc-app"]').waitFor({ timeout: 30000 }).then(() => console.log('roc-app visible'));
} catch (error) {
  console.log('firstWindow/page error:', error.message);
}
await app.close();
