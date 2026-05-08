import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getElectronVersion, packageJsonPath, projectRoot } from './electron-version.mjs';

export const betterSqlite3ModuleName = 'better-sqlite3';
export const betterSqlite3ModuleRoot = resolve(projectRoot, 'node_modules', betterSqlite3ModuleName);
export const betterSqlite3PackagedRelativeRoot = join(
  'resources',
  'app.asar.unpacked',
  'node_modules',
  betterSqlite3ModuleName
);
export const betterSqlite3WorkspaceRequireBase = packageJsonPath;

const probeScriptPath = resolve(projectRoot, 'scripts', 'probe-better-sqlite3.cjs');
const electronBuilderCache = resolve(projectRoot, '.runtime', 'electron-builder-cache');

export function createPackagingEnvironment(baseEnvironment = process.env) {
  mkdirSync(electronBuilderCache, { recursive: true });
  return {
    ...baseEnvironment,
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false'
  };
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  return result.status === null ? 1 : result.status;
}

export function prepareBetterSqlite3ForElectron({
  electronVersion = getElectronVersion(),
  projectRoot: targetProjectRoot = projectRoot,
  run = runCommand
} = {}) {
  const rebuildStatus = run('pnpm', [
    'exec',
    'electron-rebuild',
    '--force',
    '--only',
    betterSqlite3ModuleName,
    '--version',
    electronVersion,
    '--module-dir',
    targetProjectRoot
  ]);
  if (rebuildStatus === 0) {
    return { strategy: 'electron-rebuild' };
  }

  const fallbackStatus = run(
    'pnpm',
    [
      'exec',
      'prebuild-install',
      `--runtime=electron`,
      `--target=${electronVersion}`,
      '--arch=x64',
      '--platform=win32'
    ],
    { cwd: resolve(targetProjectRoot, 'node_modules', betterSqlite3ModuleName) }
  );
  if (fallbackStatus !== 0) {
    throw new Error(
      `Failed to prepare ${betterSqlite3ModuleName} for Electron ${electronVersion}: electron-rebuild exited ${rebuildStatus}, prebuild-install exited ${fallbackStatus}.`
    );
  }

  return { strategy: 'prebuild-install' };
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

export function prepareAndVerifyWorkspaceBetterSqlite3(options = {}) {
  const result = prepareBetterSqlite3ForElectron(options);
  verifyBetterSqlite3WithElectron({
    label: 'workspace-better-sqlite3',
    ...options
  });
  return result;
}

export function restoreBetterSqlite3ForNode({
  projectRoot: targetProjectRoot = projectRoot,
  run = runCommand
} = {}) {
  const restoreStatus = run('pnpm', ['rebuild', betterSqlite3ModuleName, '--pending=false'], {
    cwd: targetProjectRoot
  });
  if (restoreStatus !== 0) {
    throw new Error(`Failed to restore ${betterSqlite3ModuleName} for Node with exit code ${restoreStatus}.`);
  }
}

export function resolvePackagedBetterSqlite3Root(appOutDir) {
  return resolve(appOutDir, betterSqlite3PackagedRelativeRoot);
}

export function resolvePackagedBetterSqlite3RequireBase(appOutDir) {
  return resolve(appOutDir, 'resources', 'app.asar', 'package.json');
}

export function verifyPackagedBetterSqlite3({
  appOutDir,
  projectRoot: targetProjectRoot = projectRoot,
  run = runCommand
}) {
  verifyBetterSqlite3WithElectron({
    label: 'packaged-better-sqlite3',
    requireBase: resolvePackagedBetterSqlite3RequireBase(appOutDir),
    projectRoot: targetProjectRoot,
    run
  });
}
