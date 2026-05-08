import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const electronBuilderConfig = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');

async function loadElectronVersionModule() {
  return import(new URL('../../scripts/lib/electron-version.mjs', import.meta.url).href);
}

async function loadNativePackagingModule() {
  return import(new URL('../../scripts/lib/native-packaging.mjs', import.meta.url).href);
}

describe('native packaging contract', () => {
  it('reads the Electron version from package.json as the single source of truth', async () => {
    const { getElectronVersion } = await loadElectronVersionModule();

    expect(getElectronVersion()).toBe(packageJson.devDependencies.electron);
  });

  it('registers builder hooks for native prepare, packaged verify, and restore', () => {
    expect(electronBuilderConfig).toContain('beforePack: ./scripts/builder-hooks/before-pack.mjs');
    expect(electronBuilderConfig).toContain('afterPack: ./scripts/builder-hooks/after-pack.mjs');
    expect(electronBuilderConfig).toContain(
      'afterAllArtifactBuild: ./scripts/builder-hooks/after-all-artifact-build.mjs'
    );
  });

  it('uses electron-rebuild first and skips prebuild-install when rebuild succeeds', async () => {
    const run = vi.fn().mockReturnValueOnce(0);
    const { prepareBetterSqlite3ForElectron } = await loadNativePackagingModule();

    const result = prepareBetterSqlite3ForElectron({
      electronVersion: '41.3.0',
      projectRoot: 'F:/Code/Roc',
      run
    });

    expect(result).toEqual({ strategy: 'electron-rebuild' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('pnpm', [
      'exec',
      'electron-rebuild',
      '--force',
      '--only',
      'better-sqlite3',
      '--version',
      '41.3.0',
      '--module-dir',
      'F:/Code/Roc'
    ]);
  });

  it('falls back to prebuild-install when electron-rebuild fails', async () => {
    const run = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(0);
    const { prepareBetterSqlite3ForElectron } = await loadNativePackagingModule();

    const result = prepareBetterSqlite3ForElectron({
      electronVersion: '41.3.0',
      projectRoot: 'F:/Code/Roc',
      run
    });

    expect(result).toEqual({ strategy: 'prebuild-install' });
    expect(run).toHaveBeenNthCalledWith(1, 'pnpm', [
      'exec',
      'electron-rebuild',
      '--force',
      '--only',
      'better-sqlite3',
      '--version',
      '41.3.0',
      '--module-dir',
      'F:/Code/Roc'
    ]);
    expect(run).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      [
        'exec',
        'prebuild-install',
        '--runtime=electron',
        '--target=41.3.0',
        '--arch=x64',
        '--platform=win32'
      ],
      { cwd: resolve('F:/Code/Roc/node_modules/better-sqlite3') }
    );
  });

  it('verifies packaged better-sqlite3 from the app.asar package boundary', async () => {
    const run = vi.fn().mockReturnValueOnce(0);
    const { verifyPackagedBetterSqlite3 } = await loadNativePackagingModule();

    verifyPackagedBetterSqlite3({
      appOutDir: 'F:/Code/Roc/release/win-unpacked',
      run
    });

    expect(run).toHaveBeenCalledWith(
      'pnpm',
      [
        'exec',
        'electron',
        expect.stringContaining('scripts'),
        resolve('F:/Code/Roc/release/win-unpacked/resources/app.asar/package.json'),
        'better-sqlite3',
        'packaged-better-sqlite3'
      ],
      { cwd: expect.any(String) }
    );
  });
});
