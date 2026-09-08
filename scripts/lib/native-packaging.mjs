import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { packageJsonPath, projectRoot } from './electron-version.mjs';

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
const windowsIconApplyAttempts = 3;
const windowsIconApplyRetryDelayMs = 250;
const compareExecutableIconScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$exePath = $env:ROC_EXECUTABLE_ICON_EXE
$iconPath = $env:ROC_EXECUTABLE_ICON_ICO
$exeIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)
if ($null -eq $exeIcon) {
  throw "Unable to extract icon from $exePath."
}

$resourceIcon = [System.Drawing.Icon]::new($iconPath)
$exeBitmap = $exeIcon.ToBitmap()
$resourceBitmap = $resourceIcon.ToBitmap()

try {
  if ($exeBitmap.Width -ne $resourceBitmap.Width -or $exeBitmap.Height -ne $resourceBitmap.Height) {
    throw "Icon dimensions differ: exe=$($exeBitmap.Width)x$($exeBitmap.Height), resource=$($resourceBitmap.Width)x$($resourceBitmap.Height)."
  }

  for ($y = 0; $y -lt $exeBitmap.Height; $y++) {
    for ($x = 0; $x -lt $exeBitmap.Width; $x++) {
      if ($exeBitmap.GetPixel($x, $y).ToArgb() -ne $resourceBitmap.GetPixel($x, $y).ToArgb()) {
        throw "Icon pixel mismatch at $x,$y."
      }
    }
  }
} finally {
  if ($null -ne $exeBitmap) {
    $exeBitmap.Dispose()
  }
  if ($null -ne $resourceBitmap) {
    $resourceBitmap.Dispose()
  }
  if ($null -ne $exeIcon) {
    $exeIcon.Dispose()
  }
  if ($null -ne $resourceIcon) {
    $resourceIcon.Dispose()
  }
}
`;


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
    stdio: options.stdio ?? 'inherit',
    shell: useWindowsShell
  });
  return result.status === null ? 1 : result.status;
}

export function resolveWindowsRceditPath({
  projectRoot: targetProjectRoot = projectRoot
} = {}) {
  const pnpmPackagesRoot = resolve(targetProjectRoot, 'node_modules', '.pnpm');
  const packageDirectories = readdirSync(pnpmPackagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('electron-winstaller@'))
    .map((entry) => entry.name)
    .sort();
  for (const packageDirectory of packageDirectories) {
    const rceditPath = resolve(
      pnpmPackagesRoot,
      packageDirectory,
      'node_modules',
      'electron-winstaller',
      'vendor',
      'rcedit.exe'
    );
    if (existsSync(rceditPath)) {
      return rceditPath;
    }
  }
  throw new Error('Unable to locate electron-winstaller vendor rcedit.exe.');
}

export function applyWindowsExecutableIcon({
  appOutDir,
  executableName = 'Roc',
  iconPath = resolve(projectRoot, 'resources', 'icon.ico'),
  projectRoot: targetProjectRoot = projectRoot,
  run = runCommand,
  platform = process.platform,
  resolveRceditPath = resolveWindowsRceditPath,
  terminateRunningApp = terminateRunningPackagedApp
}) {
  if (platform !== 'win32') {
    return { applied: false };
  }
  const executablePath = resolve(appOutDir, `${executableName}.exe`);
  terminateRunningApp({ packagedExecutablePath: executablePath });
  const rceditPath = resolveRceditPath({ projectRoot: targetProjectRoot });
  let status = 1;
  sleepSync(windowsIconApplyRetryDelayMs);
  for (let attempt = 1; attempt <= windowsIconApplyAttempts; attempt += 1) {
    const isFinalAttempt = attempt === windowsIconApplyAttempts;
    status = run(rceditPath, [executablePath, '--set-icon', iconPath], {
      cwd: targetProjectRoot,
      stdio: isFinalAttempt ? 'inherit' : 'pipe'
    });
    if (status === 0) {
      return { applied: true, executablePath, iconPath };
    }
    if (attempt < windowsIconApplyAttempts) {
      sleepSync(windowsIconApplyRetryDelayMs);
    }
  }
  throw new Error(`Failed to apply Windows executable icon to ${executablePath}: rcedit exited ${status}.`);
}

export function verifyWindowsExecutableIcon({
  appOutDir,
  executableName = 'Roc',
  iconPath = resolve(projectRoot, 'resources', 'icon.ico'),
  projectRoot: targetProjectRoot = projectRoot,
  run = runCommand,
  platform = process.platform
}) {
  if (platform !== 'win32') {
    return { verified: false };
  }
  const executablePath = resolve(appOutDir, `${executableName}.exe`);
  const status = run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', compareExecutableIconScript],
    {
      cwd: targetProjectRoot,
      env: {
        ...process.env,
        ROC_EXECUTABLE_ICON_EXE: executablePath,
        ROC_EXECUTABLE_ICON_ICO: iconPath
      }
    }
  );
  if (status !== 0) {
    throw new Error(`Packaged Windows executable icon does not match ${iconPath}: ${executablePath}.`);
  }
  return { verified: true, executablePath, iconPath };
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
  platform = process.platform,
  waitTimeoutMs = 5000
} = {}) {
  if (platform !== 'win32') {
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
