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

  it('packages the current-architecture research toolchain and its licenses', () => {
    expect(electronBuilderConfig).toContain('from: .runtime/research-toolchain/darwin-${arch}');
    expect(electronBuilderConfig).toContain('to: research-toolchain');
    expect(electronBuilderConfig).toContain('"!models"');
    expect(electronBuilderConfig).toContain('"!models/**"');
    expect(electronBuilderConfig).toContain('"!bibliography.py"');
    expect(electronBuilderConfig).toContain('"!**/PyObjCTest"');
    expect(electronBuilderConfig).toContain('"!**/debugpy"');
    expect(electronBuilderConfig).toContain('"!**/jedi"');
    expect(electronBuilderConfig).toContain('"!**/*.pyc"');
    expect(electronBuilderConfig).not.toContain('from: resources/research-runtime/worker.py');
    expect(beforePackHook).toContain('assertLiveResearchToolchainForPackaging');
    expect(afterPackHook).toContain('finalizePackagedResearchToolchain');
    expect(afterPackHook).toContain('verifyPackagedResearchToolchain');
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
    expect(electronBuilderConfig).toContain('node_modules/@napi-rs/canvas/**');
    expect(electronBuilderConfig).toContain('node_modules/@napi-rs/canvas-darwin-${arch}/**');
    expect(electronBuilderConfig).toContain('node_modules/pdfjs-dist/**');
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

  it('requires packaged research toolchain binaries and license records', async () => {
    const { verifyPackagedResearchToolchain } = await loadNativePackagingModule();
    const projectRoot = createTemporaryDirectory();
    mkdirSync(join(projectRoot, 'resources/research-runtime'), { recursive: true });
    writeFileSync(join(projectRoot, 'resources/research-runtime/worker.py'), 'license');
    writeFileSync(join(projectRoot, 'resources/research-runtime/figure.py'), 'license');
    const resourcesDir = join(createTemporaryDirectory(), 'Roc.app', 'Contents', 'Resources');
    const root = join(resourcesDir, 'research-toolchain');
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, 'python', 'bin'), { recursive: true });
    mkdirSync(join(root, 'tex'), { recursive: true });
    mkdirSync(join(root, 'licenses'), { recursive: true });
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ platform: 'darwin', architecture: process.arch }));
    for (const relativePath of ['worker.py', 'figure.py', 'bin/tectonic', 'bin/uv', 'python/bin/python3', 'tex/bundle.zip',
      'licenses/README.md', 'licenses/sources.json', 'licenses/tectonic-MIT.txt', 'licenses/uv-MIT.txt', 'licenses/uv-APACHE.txt', 'licenses/CDLA-Permissive-2.0.txt']) {
      mkdirSync(resolve(join(root, relativePath), '..'), { recursive: true });
      writeFileSync(join(root, relativePath), 'license');
    }
    expect(() => verifyPackagedResearchToolchain({ resourcesDir, architecture: process.arch, projectRoot })).toThrow(/licenses\/python-packages\.json/);
    writeFileSync(join(root, 'licenses/python-packages.json'), JSON.stringify([{ name: 'docling', licenseExpression: 'MIT' }]));
    expect(() => verifyPackagedResearchToolchain({ resourcesDir, architecture: process.arch, projectRoot })).not.toThrow();
    mkdirSync(join(root, 'models'), { recursive: true });
    expect(() => verifyPackagedResearchToolchain({ resourcesDir, architecture: process.arch, projectRoot })).toThrow(/must not include models/);
    rmSync(join(root, 'models'), { recursive: true, force: true });
    writeFileSync(join(root, 'bibliography.py'), 'legacy');
    expect(() => verifyPackagedResearchToolchain({ resourcesDir, architecture: process.arch, projectRoot })).toThrow(/must not include bibliography.py/);
    rmSync(join(root, 'bibliography.py'));
    mkdirSync(join(root, 'python/lib/python3.12/site-packages/PyObjCTest'), { recursive: true });
    writeFileSync(join(root, 'python/lib/python3.12/site-packages/PyObjCTest/test.py'), 'legacy');
    expect(() => verifyPackagedResearchToolchain({ resourcesDir, architecture: process.arch, projectRoot })).toThrow(/must not include PyObjCTest/);
  });

  it('fails before packing when the live research toolchain is missing', async () => {
    const { assertLiveResearchToolchainForPackaging } = await loadNativePackagingModule();
    const projectRoot = createTemporaryDirectory();
    mkdirSync(join(projectRoot, 'resources/research-runtime'), { recursive: true });
    writeFileSync(join(projectRoot, 'resources/research-runtime/worker.py'), 'worker');
    writeFileSync(join(projectRoot, 'resources/research-runtime/figure.py'), 'figure');
    expect(() => assertLiveResearchToolchainForPackaging({
      architecture: process.arch,
      projectRoot
    })).toThrow(/Missing research toolchain for packaging: manifest.json/);
  });

  it('overlays current research sources and drops leftover files from the packaged toolchain', async () => {
    const { finalizePackagedResearchToolchain, verifyPackagedResearchToolchain } = await loadNativePackagingModule();
    const projectRoot = createTemporaryDirectory();
    const resourcesDir = join(createTemporaryDirectory(), 'Roc.app', 'Contents', 'Resources');
    const root = join(resourcesDir, 'research-toolchain');
    mkdirSync(join(projectRoot, 'resources/research-runtime'), { recursive: true });
    writeFileSync(join(projectRoot, 'resources/research-runtime/worker.py'), 'current-worker');
    writeFileSync(join(projectRoot, 'resources/research-runtime/figure.py'), 'current-figure');
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, 'python/bin'), { recursive: true });
    mkdirSync(join(root, 'python/lib/python3.12/site-packages/PyObjCTest'), { recursive: true });
    mkdirSync(join(root, 'python/lib/python3.12/site-packages/debugpy'), { recursive: true });
    mkdirSync(join(root, 'python/lib/python3.12/site-packages/debugpy-1.8.0.dist-info'), { recursive: true });
    mkdirSync(join(root, 'python/lib/python3.12/site-packages/ocrmac/__pycache__'), { recursive: true });
    mkdirSync(join(root, 'tex'), { recursive: true });
    mkdirSync(join(root, 'licenses'), { recursive: true });
    mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(join(root, 'worker.py'), 'stale-worker');
    writeFileSync(join(root, 'bibliography.py'), 'legacy-bib');
    writeFileSync(join(root, 'python/lib/python3.12/site-packages/PyObjCTest/test.py'), 'legacy-test');
    writeFileSync(join(root, 'python/lib/python3.12/site-packages/debugpy/__init__.py'), 'legacy-debug');
    writeFileSync(join(root, 'python/lib/python3.12/site-packages/debugpy-1.8.0.dist-info/METADATA'), 'legacy-meta');
    writeFileSync(join(root, 'python/lib/python3.12/site-packages/ocrmac/__pycache__/mod.cpython-312.pyc'), 'pyc');
    writeFileSync(join(root, 'python/lib/python3.12/site-packages/keep.py'), 'keep');
    for (const relativePath of ['bin/tectonic', 'bin/uv', 'python/bin/python3', 'tex/bundle.zip',
      'licenses/README.md', 'licenses/sources.json', 'licenses/tectonic-MIT.txt', 'licenses/uv-MIT.txt', 'licenses/uv-APACHE.txt', 'licenses/CDLA-Permissive-2.0.txt']) {
      mkdirSync(resolve(join(root, relativePath), '..'), { recursive: true });
      writeFileSync(join(root, relativePath), 'license');
    }
    writeFileSync(join(root, 'licenses/python-packages.json'), JSON.stringify([{ name: 'docling', licenseExpression: 'MIT' }]));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      platform: 'darwin',
      architecture: process.arch,
      lockHashes: { 'worker.py': 'stale', 'bibliography.py': 'legacy' },
      entries: [
        { path: 'bibliography.py', type: 'file', size: 10, sha256: 'aa', executable: false },
        { path: 'worker.py', type: 'file', size: 12, sha256: 'bb', executable: false }
      ]
    }));
    finalizePackagedResearchToolchain({ resourcesDir, architecture: process.arch, projectRoot });
    expect(readFileSync(join(root, 'worker.py'), 'utf8')).toBe('current-worker');
    expect(readFileSync(join(root, 'figure.py'), 'utf8')).toBe('current-figure');
    expect(existsSync(join(root, 'bibliography.py'))).toBe(false);
    expect(existsSync(join(root, 'models'))).toBe(false);
    expect(existsSync(join(root, 'python/lib/python3.12/site-packages/PyObjCTest'))).toBe(false);
    expect(existsSync(join(root, 'python/lib/python3.12/site-packages/debugpy'))).toBe(false);
    expect(existsSync(join(root, 'python/lib/python3.12/site-packages/debugpy-1.8.0.dist-info'))).toBe(false);
    expect(existsSync(join(root, 'python/lib/python3.12/site-packages/ocrmac/__pycache__'))).toBe(false);
    expect(readFileSync(join(root, 'python/lib/python3.12/site-packages/keep.py'), 'utf8')).toBe('keep');
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    expect(manifest.lockHashes['bibliography.py']).toBeUndefined();
    expect(manifest.lockHashes['worker.py']).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.lockHashes['figure.py']).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.entries.some((entry: { path: string }) => entry.path === 'bibliography.py')).toBe(false);
    expect(manifest.entries.some((entry: { path: string }) => entry.path === 'figure.py')).toBe(true);
    expect(() => verifyPackagedResearchToolchain({ resourcesDir, architecture: process.arch, projectRoot })).not.toThrow();
    writeFileSync(join(root, 'worker.py'), 'stale-again');
    expect(() => verifyPackagedResearchToolchain({ resourcesDir, architecture: process.arch, projectRoot })).toThrow(/worker\.py does not match current source/);
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
