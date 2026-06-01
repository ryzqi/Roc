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

export function buildWindowsShellCommand(command, args) {
  return [command, ...args].map((part) => {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(part)) {
      return part;
    }
    return `"${part.replaceAll('"', '\\"')}"`;
  }).join(' ');
}

export function runCommand(command, args, options = {}) {
  const useWindowsShell = process.platform === 'win32';
  const result = spawnSync(useWindowsShell ? buildWindowsShellCommand(command, args) : command, useWindowsShell ? [] : args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    shell: useWindowsShell
  });
  return result.status === null ? 1 : result.status;
}

export function listWindowsProcessesByName(processName) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "name = '${processName}'" | ConvertTo-Json -Compress`
    ],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Failed to list ${processName} processes.`);
  }
  const output = result.stdout.trim();
  if (output.length === 0) {
    return [];
  }

  const parsed = JSON.parse(output);
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  return processes.flatMap((process) => {
    const pid = process.ProcessId;
    const executablePath = process.ExecutablePath;
    if (typeof pid !== 'number' || typeof executablePath !== 'string') {
      return [];
    }
    return [{ pid, executablePath }];
  });
}

export function terminateWindowsProcess(pid) {
  const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'inherit',
    windowsHide: true
  });
  return result.status === null ? 1 : result.status;
}

function normalizeWindowsPath(value) {
  return value.replaceAll('/', '\\').toLowerCase();
}

function isPackagedExecutableProcess(process, targetPath) {
  return normalizeWindowsPath(resolve(process.executablePath)) === targetPath;
}

function sleepSync(ms) {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function terminateRunningPackagedApp({
  packagedExecutablePath = resolve(projectRoot, 'release', 'win-unpacked', 'Roc.exe'),
  listProcesses = () => listWindowsProcessesByName('Roc.exe'),
  stopProcess = terminateWindowsProcess,
  waitTimeoutMs = 5000
} = {}) {
  if (process.platform !== 'win32') {
    return { terminatedPids: [] };
  }

  const targetPath = normalizeWindowsPath(resolve(packagedExecutablePath));
  const matchingProcesses = listProcesses().filter(
    (process) => isPackagedExecutableProcess(process, targetPath)
  );
  if (matchingProcesses.length === 0) {
    return { terminatedPids: [] };
  }

  const terminatedPids = [];
  for (const matchingProcess of matchingProcesses) {
    const status = stopProcess(matchingProcess.pid);
    if (status !== 0) {
      const stillRunning = listProcesses().some(
        (process) => process.pid === matchingProcess.pid && isPackagedExecutableProcess(process, targetPath)
      );
      if (stillRunning) {
        throw new Error(`Failed to terminate packaged Roc.exe process ${matchingProcess.pid}.`);
      }
      continue;
    }
    terminatedPids.push(matchingProcess.pid);
  }

  const startedAt = Date.now();
  if (waitTimeoutMs <= 0) {
    return { terminatedPids };
  }

  while (Date.now() - startedAt < waitTimeoutMs) {
    const stillRunning = listProcesses().some(
      (process) => isPackagedExecutableProcess(process, targetPath)
    );
    if (!stillRunning) {
      return { terminatedPids };
    }
    sleepSync(100);
  }

  throw new Error(`Timed out waiting for packaged Roc.exe processes to exit: ${terminatedPids.join(', ')}.`);
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
