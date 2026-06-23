import config from '../../electron.vite.config';
import { readFileSync } from 'node:fs';

describe('main bundle boundaries', () => {
  it('keeps Electron as a runtime external in the main process bundle', () => {
    const external = config.main?.build?.rollupOptions?.external;

    expect(external).toEqual(expect.arrayContaining(['electron']));
  });

  it('keeps Electron as a runtime external in the preload bundle', () => {
    const external = config.preload?.build?.rollupOptions?.external;

    expect(external).toEqual(expect.arrayContaining(['electron']));
  });

  it('does not rely on CommonJS __dirname in the ESM main process entry', () => {
    const mainEntry = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');

    expect(mainEntry).not.toContain('__dirname');
    expect(mainEntry).toContain('fileURLToPath(import.meta.url)');
  });
});
