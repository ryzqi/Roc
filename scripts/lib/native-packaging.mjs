import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { packageJsonPath, projectRoot } from './electron-version.mjs';

export const betterSqlite3ModuleName = 'better-sqlite3';
export const betterSqlite3ModuleRoot = resolve(projectRoot, 'node_modules', betterSqlite3ModuleName);
export const betterSqlite3PackagedRelativeRoot = join(
  'Contents',
  'Resources',
  'app.asar.unpacked',
  'node_modules',
  betterSqlite3ModuleName
);
export const betterSqlite3WorkspaceRequireBase = packageJsonPath;

const probeScriptPath = resolve(projectRoot, 'scripts', 'probe-better-sqlite3.cjs');
const electronBuilderCache = resolve(projectRoot, '.runtime', 'electron-builder-cache');
export const langgraphSdkPackageName = '@langchain/langgraph-sdk';


export function hasBundledPnpmRelativeImports(source) {
  return typeof source === 'string' && source.includes('node_modules/.pnpm/');
}

export function rewriteBundledPnpmRelativeImports(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('rewriteBundledPnpmRelativeImports requires a non-empty source string.');
  }

  let next = source;
  next = next.replace(
    /from\s+["'](?:\.\.\/)+node_modules\/\.pnpm\/[^"']+\/node_modules\/((?:@[^/"']+\/)?[^/"']+)\/[^"']+["']/g,
    'from "$1"'
  );
  next = next.replace(
    /import\s+["'](?:\.\.\/)+node_modules\/\.pnpm\/[^"']+\/node_modules\/((?:@[^/"']+\/)?[^/"']+)\/[^"']+["']/g,
    'import "$1"'
  );
  next = next.replace(
    /require\(\s*["'](?:\.\.\/)+node_modules\/\.pnpm\/[^"']+\/node_modules\/((?:@[^/"']+\/)?[^/"']+)\/[^"']+["']\s*\)/g,
    'require("$1")'
  );
  return next;
}

export function findLanggraphSdkPackageRoots(targetProjectRoot = projectRoot) {
  const roots = [];
  const pnpmDir = resolve(targetProjectRoot, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) {
    return roots;
  }

  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('@langchain+langgraph-sdk@')) {
      continue;
    }
    const packageRoot = resolve(pnpmDir, entry.name, 'node_modules', '@langchain', 'langgraph-sdk');
    if (existsSync(resolve(packageRoot, 'package.json'))) {
      roots.push(packageRoot);
    }
  }

  return roots;
}

function listPackagingCandidateFiles(packageRoot) {
  const files = [];
  const distRoot = resolve(packageRoot, 'dist');
  if (!existsSync(distRoot)) {
    return files;
  }

  const queue = [distRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        // electron-builder already drops nested node_modules; skip vendored trees here.
        if (entry.name === 'node_modules') {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs') || entry.name.endsWith('.mjs')) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export function sanitizeLanggraphSdkForPackaging({
  projectRoot: targetProjectRoot = projectRoot
} = {}) {
  const packageRoots = findLanggraphSdkPackageRoots(targetProjectRoot);
  const rewrittenFiles = [];

  for (const packageRoot of packageRoots) {
    for (const filePath of listPackagingCandidateFiles(packageRoot)) {
      const original = readFileSync(filePath, 'utf8');
      if (!hasBundledPnpmRelativeImports(original)) {
        continue;
      }

      const rewritten = rewriteBundledPnpmRelativeImports(original);
      if (rewritten === original) {
        throw new Error(`Failed to sanitize bundled pnpm imports in ${filePath}.`);
      }
      if (hasBundledPnpmRelativeImports(rewritten)) {
        throw new Error(`Residual bundled pnpm imports remain in ${filePath}.`);
      }

      writeFileSync(filePath, rewritten, 'utf8');
      rewrittenFiles.push(filePath);
    }
  }

  return {
    packageRootCount: packageRoots.length,
    rewrittenFiles
  };
}

export function createPackagingEnvironment(baseEnvironment = process.env) {
  const localPaths = {
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    ELECTRON_CACHE: resolve(projectRoot, '.runtime', 'electron-cache'),
    npm_config_cache: resolve(projectRoot, '.runtime', 'npm-cache'),
    XDG_CACHE_HOME: resolve(projectRoot, '.runtime', 'cache'),
    TMPDIR: resolve(projectRoot, '.runtime', 'tmp')
  };
  for (const directory of Object.values(localPaths)) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    ...baseEnvironment,
    ...localPaths,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false'
  };
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'inherit',
    shell: false
  });
  return result.status === null ? 1 : result.status;
}

export function verifyBetterSqlite3WithElectron({
  label,
  moduleSpecifier = betterSqlite3ModuleName,
  requireBase = betterSqlite3WorkspaceRequireBase,
  projectRoot: targetProjectRoot = projectRoot,
  run = runCommand
}) {
  if (typeof requireBase !== 'string' || requireBase.length === 0) {
    throw new Error(`Missing requireBase for ${betterSqlite3ModuleName} verification.`);
  }

  const verifyStatus = run(
    'pnpm',
    ['exec', 'electron', probeScriptPath, requireBase, moduleSpecifier, label],
    { cwd: targetProjectRoot }
  );
  if (verifyStatus !== 0) {
    throw new Error(
      `Electron verify failed for ${label} from ${requireBase} with exit code ${verifyStatus}.`
    );
  }
}

// better-sqlite3 13 与 node-pty 1.1 均为 N-API 模块,包内自带各平台 prebuilds,
// 同一份二进制在 Node 与 Electron 的不同 ABI 下都能加载,因此无需再按 ABI 重建/还原,只需验证 Electron 侧真实可加载。
export function verifyWorkspaceBetterSqlite3(options = {}) {
  verifyBetterSqlite3WithElectron({
    label: 'workspace-better-sqlite3',
    ...options
  });
}

export function resolvePackagedBetterSqlite3Root(appOutDir) {
  return resolve(appOutDir, betterSqlite3PackagedRelativeRoot);
}

export function resolvePackagedBetterSqlite3RequireBase(resourcesDir) {
  return resolve(resourcesDir, 'app.asar', 'package.json');
}

export function verifyPackagedFileLayout({ resourcesDir }) {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const packagerRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const { getRawHeader } = packagerRequire('@electron/asar');
  const archive = resolve(resourcesDir, 'app.asar');
  const entries = Object.keys(getRawHeader(archive).header.files).sort();
  const expected = ['dist', 'node_modules', 'package.json'];
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new Error(`Unexpected packaged app files: ${entries.join(', ')}. Only dist, node_modules and package.json may ship.`);
  }
}

export function verifyPackagedBetterSqlite3({
  resourcesDir,
  projectRoot: targetProjectRoot = projectRoot,
  run = runCommand
}) {
  verifyBetterSqlite3WithElectron({
    label: 'packaged-better-sqlite3',
    requireBase: resolvePackagedBetterSqlite3RequireBase(resourcesDir),
    moduleSpecifier: resolve(resourcesDir, 'app.asar', 'node_modules', betterSqlite3ModuleName),
    projectRoot: targetProjectRoot,
    run
  });
}

export function preparePackagedNodePty({ resourcesDir, platform = process.platform }) {
  prepareNodePtyHelpers({
    packageRoot: resolve(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty'),
    platform
  });
}

export function prepareWorkspaceNodePty({ projectRoot: targetProjectRoot = projectRoot, platform = process.platform } = {}) {
  prepareNodePtyHelpers({ packageRoot: resolve(targetProjectRoot, 'node_modules', 'node-pty'), platform });
}

function prepareNodePtyHelpers({ packageRoot, platform }) {
  if (platform !== 'darwin' && platform !== 'mas') {
    return;
  }
  const prebuildsDir = resolve(packageRoot, 'prebuilds');
  const macPrebuilds = readdirSync(prebuildsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('darwin-'));
  if (macPrebuilds.length === 0) {
    throw new Error(`Missing macOS node-pty prebuilds in ${prebuildsDir}.`);
  }
  for (const entry of macPrebuilds) {
    const helperPath = resolve(prebuildsDir, entry.name, 'spawn-helper');
    chmodSync(helperPath, statSync(helperPath).mode | 0o111);
  }
}
