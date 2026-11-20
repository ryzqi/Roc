import { writeFatalArtifact } from './artifacts.mjs';

/**
 * Waits until the shell's root node is on screen.
 *
 * P10: the legacy `.fatal` / `.boot` fallbacks are gone with the legacy shell; the new shell renders
 * `roc-app-startup` / `roc-app-startup-error` while it reads `app.getStatus()` (see
 * `src/renderer/shell/`), so the wait is expressed in the shell's own test ids.
 */
export async function waitForAppReady(page, label, artifactDir) {
  await page.waitForSelector('[data-testid="roc-app"], [data-testid="roc-app-startup"], [data-testid="roc-app-startup-error"]', {
    timeout: 15000
  });
  if ((await page.locator('[data-testid="roc-app-startup-error"]').count()) > 0) {
    const text = (await page.textContent('[data-testid="roc-app-startup-error"]')) ?? '';
    writeFatalArtifact(artifactDir, label, text);
    throw new Error(`Roc renderer fatal during ${label}: ${text}`);
  }
  if ((await page.locator('[data-testid="roc-app"]').count()) === 0) {
    await page.waitForSelector('[data-testid="roc-app"]', { timeout: 15000 });
  }
}
