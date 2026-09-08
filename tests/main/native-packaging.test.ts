import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const electronBuilderConfig = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
const beforePackHook = readFileSync(new URL('../../scripts/builder-hooks/before-pack.mjs', import.meta.url), 'utf8');
const afterPackHook = readFileSync(new URL('../../scripts/builder-hooks/after-pack.mjs', import.meta.url), 'utf8');
const packageDirScript = readFileSync(new URL('../../scripts/package-dir.mjs', import.meta.url), 'utf8');
const verifyNativePackagingScript = readFileSync(new URL('../../scripts/verify-native-packaging.mjs', import.meta.url), 'utf8');
const temporaryDirectories: string[] = [];

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'roc-native-packaging-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  it('removes default Electron app artifacts from the macOS bundle', async () => {
    const { default: afterExtract } = await import(new URL('../../scripts/builder-hooks/after-extract.mjs', import.meta.url).href);
    const appOutDir = createTemporaryDirectory();
    const electronDestination = join(appOutDir, 'Electron.app');
    const resourcesDir = join(electronDestination, 'Contents', 'Resources');
    mkdirSync(resourcesDir, { recursive: true });
    writeFileSync(join(resourcesDir, 'default_app.asar'), 'default app');
    writeFileSync(join(resourcesDir, 'keep.txt'), 'keep');
    writeFileSync(join(appOutDir, 'version'), '44.0.0');

    await afterExtract({
      appOutDir,
      electronPlatformName: 'darwin',
      packager: { getElectronDestinationDir: () => electronDestination }
    });

    expect(existsSync(join(resourcesDir, 'default_app.asar'))).toBe(false);
    expect(existsSync(join(appOutDir, 'version'))).toBe(false);
    expect(readFileSync(join(resourcesDir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('no longer restores better-sqlite3 after the package-dir command exits', () => {
    expect(packageDirScript).not.toContain('restoreBetterSqlite3ForNode');
  });

  it('packages bundled RTK binaries as external resources', () => {
    expect(electronBuilderConfig).toContain('extraResources:');
    expect(electronBuilderConfig).toContain('from: resources/rtk-binaries');
    expect(electronBuilderConfig).toContain('to: rtk-binaries');
  });

  it('limits macOS package resources to runtime files', () => {
    expect(electronBuilderConfig).toContain('electronLanguages:');
    expect(electronBuilderConfig).toContain('  - en-US');
    expect(electronBuilderConfig).toContain('  - zh-CN');
    expect(electronBuilderConfig).toContain('!**/*.map');
    expect(electronBuilderConfig).toContain('!**/*.d.ts');
    expect(electronBuilderConfig).toContain('!**/*.d.mts');
    expect(electronBuilderConfig).toContain('!**/*.d.cts');
    expect(electronBuilderConfig).toContain('darwin-${arch}/**');
  });

  it('excludes native module build inputs and non-target prebuilds from the package', () => {
    expect(electronBuilderConfig).toContain('!node_modules/better-sqlite3/deps/**');
    expect(electronBuilderConfig).toContain('!node_modules/better-sqlite3/src/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/src/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/typings/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/scripts/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/deps/**');
    expect(electronBuilderConfig).not.toContain('!node_modules/node-pty/prebuilds/darwin-*/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/prebuilds/!(darwin-${arch})/**');
    expect(electronBuilderConfig).toContain('!node_modules/node-pty/third_party/**');
  });

  it('verifies workspace better-sqlite3 under Electron without rebuilding it', async () => {
    const run = vi.fn().mockReturnValueOnce(0);
    const { verifyWorkspaceBetterSqlite3 } = await loadNativePackagingModule();

    verifyWorkspaceBetterSqlite3({ projectRoot: '/Users/test/Projects/Roc', run });

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
      { cwd: '/Users/test/Projects/Roc' }
    );
  });

  it('fails loudly when better-sqlite3 cannot load under Electron', async () => {
    const run = vi.fn().mockReturnValueOnce(1);
    const { verifyWorkspaceBetterSqlite3 } = await loadNativePackagingModule();

    expect(() => verifyWorkspaceBetterSqlite3({ projectRoot: '/Users/test/Projects/Roc', run })).toThrow(
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

  it.each(['resources', 'Roc.app/Contents/Resources'])('verifies packaged better-sqlite3 inside the %s package boundary', async (relativeResourcesDir) => {
    const run = vi.fn().mockReturnValueOnce(0);
    const { verifyPackagedBetterSqlite3 } = await loadNativePackagingModule();
    const resourcesDir = resolve(createTemporaryDirectory(), relativeResourcesDir);

    verifyPackagedBetterSqlite3({
      resourcesDir,
      run
    });

    expect(run).toHaveBeenCalledWith(
      'pnpm',
      [
        'exec',
        'electron',
        expect.stringContaining('scripts'),
        resolve(resourcesDir, 'app.asar/package.json'),
        resolve(resourcesDir, 'app.asar/node_modules/better-sqlite3'),
        'packaged-better-sqlite3'
      ],
      { cwd: expect.any(String) }
    );
  });

  it('makes macOS packaged terminal helpers executable for both bundled architectures', async () => {
    const { preparePackagedNodePty } = await loadNativePackagingModule();
    const resourcesDir = join(createTemporaryDirectory(), 'Roc.app', 'Contents', 'Resources');
    const helperPaths = ['arm64', 'x64'].map((arch) => {
      const helperPath = join(resourcesDir, 'app.asar.unpacked/node_modules/node-pty/prebuilds', `darwin-${arch}`, 'spawn-helper');
      mkdirSync(resolve(helperPath, '..'), { recursive: true });
      writeFileSync(helperPath, 'packaged helper', { mode: 0o644 });
      return helperPath;
    });

    preparePackagedNodePty({ resourcesDir, platform: 'darwin' });

    for (const helperPath of helperPaths) {
      expect(statSync(helperPath).mode & 0o111).toBe(0o111);
      expect(() => accessSync(helperPath, constants.X_OK)).not.toThrow();
    }
  });

  it('fails when a macOS packaged terminal helper is missing', async () => {
    const { preparePackagedNodePty } = await loadNativePackagingModule();
    const resourcesDir = createTemporaryDirectory();
    mkdirSync(join(resourcesDir, 'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64'), { recursive: true });

    expect(() => preparePackagedNodePty({ resourcesDir, platform: 'darwin' })).toThrow(/ENOENT/);
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
