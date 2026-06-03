import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const electronBuilderConfig = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
const beforePackHook = readFileSync(new URL('../../scripts/builder-hooks/before-pack.mjs', import.meta.url), 'utf8');

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

  it('terminates running packaged app processes before direct electron-builder output cleanup', () => {
    expect(beforePackHook).toContain('terminateRunningPackagedApp');
  });

  it('packages bundled RTK binaries as external resources', () => {
    expect(electronBuilderConfig).toContain('extraResources:');
    expect(electronBuilderConfig).toContain('from: resources/rtk-binaries');
    expect(electronBuilderConfig).toContain('to: rtk-binaries');
  });

  it('uses the Roc icon for Windows executables and runtime window icons', () => {
    expect(electronBuilderConfig).toContain('icon: resources/icon.ico');
    expect(electronBuilderConfig).toContain('signAndEditExecutable: false');
    expect(electronBuilderConfig).toContain('from: resources/icon.ico');
    expect(electronBuilderConfig).toContain('to: icon.ico');
  });

  it('applies the Windows executable icon with rcedit without enabling the signing toolchain', async () => {
    const run = vi.fn().mockReturnValueOnce(0);
    const terminateRunningApp = vi.fn();
    const { applyWindowsExecutableIcon } = await loadNativePackagingModule();

    const result = applyWindowsExecutableIcon({
      appOutDir: 'F:/Code/Roc/release/win-unpacked',
      iconPath: 'F:/Code/Roc/resources/icon.ico',
      projectRoot: 'F:/Code/Roc',
      run,
      platform: 'win32',
      resolveRceditPath: () => 'F:/Code/Roc/node_modules/electron-winstaller/vendor/rcedit.exe',
      terminateRunningApp
    });

    expect(result).toEqual({
      applied: true,
      executablePath: resolve('F:/Code/Roc/release/win-unpacked/Roc.exe'),
      iconPath: 'F:/Code/Roc/resources/icon.ico'
    });
    expect(run).toHaveBeenCalledWith(
      'F:/Code/Roc/node_modules/electron-winstaller/vendor/rcedit.exe',
      [resolve('F:/Code/Roc/release/win-unpacked/Roc.exe'), '--set-icon', 'F:/Code/Roc/resources/icon.ico'],
      { cwd: 'F:/Code/Roc' }
    );
    expect(terminateRunningApp).toHaveBeenCalledWith({
      packagedExecutablePath: resolve('F:/Code/Roc/release/win-unpacked/Roc.exe')
    });
  });

  it('limits Windows package resources to runtime files', () => {
    expect(electronBuilderConfig).toContain('electronLanguages:');
    expect(electronBuilderConfig).toContain('  - en-US');
    expect(electronBuilderConfig).toContain('  - zh-CN');
    expect(electronBuilderConfig).toContain('!**/*.map');
    expect(electronBuilderConfig).toContain('!**/*.d.ts');
    expect(electronBuilderConfig).toContain('!**/*.d.mts');
    expect(electronBuilderConfig).toContain('!**/*.d.cts');
    expect(electronBuilderConfig).toContain('win32-x64/**');
  });

  it('excludes native module build inputs and non-target prebuilds from the package', () => {
    expect(electronBuilderConfig).toContain('!node_modules/better-sqlite3/deps/**');
    expect(electronBuilderConfig).toContain('!node_modules/better-sqlite3/src/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/src/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/typings/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/scripts/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/deps/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/prebuilds/darwin-*/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/prebuilds/win32-arm64/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/third_party/conpty/**/win10-arm64/**');
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

  it('terminates only the running Roc processes from the packaged output directory', async () => {
    const listProcesses = vi.fn()
      .mockReturnValueOnce([
        {
          pid: 101,
          executablePath: 'F:\\Code\\Roc\\release\\win-unpacked\\Roc.exe'
        },
        {
          pid: 202,
          executablePath: 'F:\\Other\\Roc\\release\\win-unpacked\\Roc.exe'
        }
      ])
      .mockReturnValueOnce([]);
    const stopProcess = vi.fn().mockReturnValue(0);
    const { terminateRunningPackagedApp } = await loadNativePackagingModule();

    const result = terminateRunningPackagedApp({
      packagedExecutablePath: 'F:\\Code\\Roc\\release\\win-unpacked\\Roc.exe',
      listProcesses,
      stopProcess,
      waitTimeoutMs: 0
    });

    expect(result.terminatedPids).toEqual([101]);
    expect(stopProcess).toHaveBeenCalledTimes(1);
    expect(stopProcess).toHaveBeenCalledWith(101);
  });

  it('continues when a packaged Roc process exits before taskkill can terminate it', async () => {
    const listProcesses = vi.fn()
      .mockReturnValueOnce([
        {
          pid: 7332,
          executablePath: 'F:\\Code\\Roc\\release\\win-unpacked\\Roc.exe'
        }
      ])
      .mockReturnValueOnce([]);
    const stopProcess = vi.fn().mockReturnValue(128);
    const { terminateRunningPackagedApp } = await loadNativePackagingModule();

    const result = terminateRunningPackagedApp({
      packagedExecutablePath: 'F:\\Code\\Roc\\release\\win-unpacked\\Roc.exe',
      listProcesses,
      stopProcess,
      waitTimeoutMs: 0
    });

    expect(result.terminatedPids).toEqual([]);
    expect(stopProcess).toHaveBeenCalledWith(7332);
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });

  it('builds Windows shell command lines so child_process does not receive shell args', async () => {
    const { buildWindowsShellCommand } = await loadNativePackagingModule();

    expect(buildWindowsShellCommand('pnpm', ['exec', 'electron-builder', '--dir'])).toBe(
      'pnpm exec electron-builder --dir'
    );
    expect(buildWindowsShellCommand('node', ['scripts/package dir.mjs', 'quoted"value'])).toBe(
      'node "scripts/package dir.mjs" "quoted\\"value"'
    );
  });
});
