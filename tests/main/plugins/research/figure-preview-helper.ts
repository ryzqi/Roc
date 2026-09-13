import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { ElectronApplication } from '@playwright/test';

export async function verifySvgPreviews(resources: Record<'figure' | 'experiment', Response>, artifacts: string): Promise<void> {
  const { _electron } = await import('@playwright/test');
  const require = createRequire(import.meta.url);
  const executable: unknown = require('electron');
  if (typeof executable !== 'string') throw new Error('electron_executable_required');
  const directory = await mkdtemp(join(tmpdir(), 'roc-figure-preview-'));
  await mkdir(artifacts, { recursive: true });
  const responses = new Map<string, { headers: Record<string, string>; bytes: Buffer }>();
  for (const [name, response] of Object.entries(resources)) responses.set(`/${name}.svg`, {
    headers: Object.fromEntries(response.headers), bytes: Buffer.from(await response.arrayBuffer())
  });
  const server = createServer((request, response) => {
    const resource = responses.get(request.url ?? '');
    if (resource === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, resource.headers); response.end(resource.bytes);
  });
  let application: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('preview_address_required');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const main = join(directory, 'main.cjs');
    await writeFile(main, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.ROC_FIGURE_TEST_USER_DATA);
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.loadURL('about:blank');
});
`);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
    env.ROC_FIGURE_TEST_USER_DATA = join(directory, 'data');
    application = await _electron.launch({ executablePath: executable, args: [main], env, timeout: 15000 });
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    const pixels: Record<string, number[]> = {};
    for (const name of Object.keys(resources)) {
      await page.goto(`${endpoint}/${name}.svg`);
      const point = await page.locator('svg').evaluate((svg) => {
        const bounds = svg.getBoundingClientRect();
        return { x: Math.floor(bounds.x + bounds.width / 2), y: Math.floor(bounds.y + bounds.height / 2), width: 1, height: 1 };
      });
      const electron = application;
      await vi.waitFor(async () => {
        pixels[name] = await electron.evaluate(async ({ BrowserWindow }, rectangle) => {
          const shot = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rectangle);
          return [...shot.toBitmap().subarray(0, 4)];
        }, point);
        expect(pixels[name]).toEqual([0, 0, 255, 255]);
      }, { timeout: 5000, interval: 100 });
      await page.screenshot({ path: join(artifacts, `${name}.png`) });
    }
    await writeFile(join(artifacts, 'preview-result.json'), JSON.stringify({ pixels, errors }, null, 2));
    expect(errors.filter((message) => message.includes('Content Security Policy'))).toEqual([]);
  } finally {
    if (application !== undefined) await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
