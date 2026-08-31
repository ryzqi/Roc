import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const electronBuilderConfig = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
const beforePackHook = readFileSync(new URL('../../scripts/builder-hooks/before-pack.mjs', import.meta.url), 'utf8');
const afterExtractHook = readFileSync(new URL('../../scripts/builder-hooks/after-extract.mjs', import.meta.url), 'utf8');
const afterPackHook = readFileSync(new URL('../../scripts/builder-hooks/after-pack.mjs', import.meta.url), 'utf8');
const packageDirScript = readFileSync(new URL('../../scripts/package-dir.mjs', import.meta.url), 'utf8');
const verifyNativePackagingScript = readFileSync(new URL('../../scripts/verify-native-packaging.mjs', import.meta.url), 'utf8');

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

  it('uses the installed Electron distribution instead of extracting the downloaded zip into release', () => {
    expect(electronBuilderConfig).toContain('electronDist: node_modules/electron/dist');
  });

  it('registers builder hooks for native prepare, extracted runtime cleanup, and packaged verify only', () => {
    expect(electronBuilderConfig).toContain('beforePack: ./scripts/builder-hooks/before-pack.mjs');
    expect(electronBuilderConfig).toContain('afterExtract: ./scripts/builder-hooks/after-extract.mjs');
    expect(electronBuilderConfig).toContain('afterPack: ./scripts/builder-hooks/after-pack.mjs');
    expect(electronBuilderConfig).not.toContain('afterAllArtifactBuild');
  });

  it('removes default Electron app artifacts left by the custom unpacked runtime', () => {
    expect(afterExtractHook).toContain("rm(join(context.appOutDir, 'resources', 'default_app.asar')");
    expect(afterExtractHook).toContain("rm(join(context.appOutDir, 'version')");
  });

  it('no longer restores better-sqlite3 after the package-dir command exits', () => {
    expect(packageDirScript).not.toContain('restoreBetterSqlite3ForNode');
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

  it('verifies the Windows executable icon after applying it', () => {
    expect(afterPackHook).toContain('applyWindowsExecutableIcon');
    expect(afterPackHook).toContain('verifyWindowsExecutableIcon');
    expect(afterPackHook.indexOf('applyWindowsExecutableIcon({')).toBeLessThan(
      afterPackHook.indexOf('verifyWindowsExecutableIcon({')
    );
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
      { cwd: 'F:/Code/Roc', stdio: 'pipe' }
    );
    expect(terminateRunningApp).toHaveBeenCalledWith({
      packagedExecutablePath: resolve('F:/Code/Roc/release/win-unpacked/Roc.exe')
    });
  });

  it('retries Windows executable icon application when rcedit fails transiently', async () => {
    const run = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(0);
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
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(
      'F:/Code/Roc/node_modules/electron-winstaller/vendor/rcedit.exe',
      [resolve('F:/Code/Roc/release/win-unpacked/Roc.exe'), '--set-icon', 'F:/Code/Roc/resources/icon.ico'],
      { cwd: 'F:/Code/Roc', stdio: 'pipe' }
    );
  });

  it('verifies packaged Roc.exe icon pixels against resources icon on Windows', async () => {
    const run = vi.fn().mockReturnValueOnce(0);
    const { verifyWindowsExecutableIcon } = await loadNativePackagingModule();

    const result = verifyWindowsExecutableIcon({
      appOutDir: 'F:/Code/Roc/release/win-unpacked',
      iconPath: 'F:/Code/Roc/resources/icon.ico',
      projectRoot: 'F:/Code/Roc',
      run,
      platform: 'win32'
    });

    const executablePath = resolve('F:/Code/Roc/release/win-unpacked/Roc.exe');
    expect(result).toEqual({
      verified: true,
      executablePath,
      iconPath: 'F:/Code/Roc/resources/icon.ico'
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      expect.stringContaining('[System.Drawing.Icon]::ExtractAssociatedIcon')
    ]);
    expect(args[5]).toContain('GetPixel');
    expect(options).toEqual({
      cwd: 'F:/Code/Roc',
      env: expect.objectContaining({
        ROC_EXECUTABLE_ICON_EXE: executablePath,
        ROC_EXECUTABLE_ICON_ICO: 'F:/Code/Roc/resources/icon.ico'
      })
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

  it('verifies workspace better-sqlite3 under Electron without rebuilding it', async () => {
    const run = vi.fn().mockReturnValueOnce(0);
    const { verifyWorkspaceBetterSqlite3 } = await loadNativePackagingModule();

    verifyWorkspaceBetterSqlite3({ projectRoot: 'F:/Code/Roc', run });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      'pnpm',
      [
        'exec',
        'electron',
        expect.stringContaining('scripts'),
        expect.stringContaining('package.json'),
        'better-sqlite3',
        'workspace-better-sqlite3'
      ],
      { cwd: 'F:/Code/Roc' }
    );
  });

  it('fails loudly when better-sqlite3 cannot load under Electron', async () => {
    const run = vi.fn().mockReturnValueOnce(1);
    const { verifyWorkspaceBetterSqlite3 } = await loadNativePackagingModule();

    expect(() => verifyWorkspaceBetterSqlite3({ projectRoot: 'F:/Code/Roc', run })).toThrow(
      /Electron verify failed for workspace-better-sqlite3/
    );
  });

  it('no longer ships ABI rebuild or restore helpers now that better-sqlite3 is N-API', async () => {
    const nativePackaging = await loadNativePackagingModule();

    expect(nativePackaging).not.toHaveProperty('prepareBetterSqlite3ForElectron');
    expect(nativePackaging).not.toHaveProperty('prepareAndVerifyWorkspaceBetterSqlite3');
    expect(nativePackaging).not.toHaveProperty('restoreBetterSqlite3ForNode');
  });

  it('verifies workspace better-sqlite3 in the standalone native packaging script', () => {
    expect(verifyNativePackagingScript).toContain('verifyWorkspaceBetterSqlite3');
    expect(verifyNativePackagingScript).not.toContain('restoreBetterSqlite3ForNode');
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

  it('rewrites langgraph-sdk bundled pnpm relative imports to package specifiers', async () => {
    const { rewriteBundledPnpmRelativeImports, hasBundledPnpmRelativeImports } = await loadNativePackagingModule();
    const source = [
      'import pRetry$1 from "../node_modules/.pnpm/p-retry@7.1.1/node_modules/p-retry/index.js";',
      'import PQueue from "../node_modules/.pnpm/p-queue@9.1.0/node_modules/p-queue/dist/index.js";',
      'const require_index = require("../node_modules/.pnpm/p-retry@7.1.1/node_modules/p-retry/index.cjs");'
    ].join('\n');

    const rewritten = rewriteBundledPnpmRelativeImports(source);
    expect(hasBundledPnpmRelativeImports(source)).toBe(true);
    expect(hasBundledPnpmRelativeImports(rewritten)).toBe(false);
    expect(rewritten).toContain('from "p-retry"');
    expect(rewritten).toContain('from "p-queue"');
    expect(rewritten).toContain('require("p-retry")');
  });

  it('sanitizes installed langgraph-sdk package sources before packaging', () => {
    expect(beforePackHook).toContain('sanitizeLanggraphSdkForPackaging');
  });

});
