import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { packageJsonPath, projectRoot } from './project-paths.mjs';

export const betterSqlite3ModuleName = 'better-sqlite3';
export const betterSqlite3WorkspaceRequireBase = packageJsonPath;

const probeScriptPath = resolve(projectRoot, 'scripts', 'probe-better-sqlite3.cjs');
const electronBuilderCache = resolve(projectRoot, '.runtime', 'electron-builder-cache');

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

export function resolvePackagedBetterSqlite3RequireBase(resourcesDir) {
  return resolve(resourcesDir, 'app.asar', 'package.json');
}

export function researchToolchainResourcePath(resourcesDir) {
  return resolve(resourcesDir, 'research-toolchain');
}

export function liveResearchToolchainPath(architecture = process.arch, targetProjectRoot = projectRoot) {
  return resolve(targetProjectRoot, '.runtime', 'research-toolchain', `darwin-${architecture}`);
}

export function researchRuntimeSourcePath(targetProjectRoot = projectRoot) {
  return resolve(targetProjectRoot, 'resources', 'research-runtime');
}

export function ripgrepBinariesRoot(targetProjectRoot = projectRoot) {
  return resolve(targetProjectRoot, 'resources', 'ripgrep-binaries');
}

/**
 * 确认**目标架构**的 `rg` 在位，且与 `ripgrep.lock.json` 记录的 SHA-256 一致。
 *
 * 缺二进制**不会**让搜索挂掉（两条调用面都会降级），所以它很容易在打包时被默默漏掉，
 * 用户拿到的是“能跑但慢”的 Roc。把校验放在打包口：漏了就失败，而不是发出去才发现。
 *
 * `architecture` 必须是**要打的那个架构**，不是宿主架构——两者在交叉构建时并不相同。
 * 现在 Roc 只发 arm64，`before-pack` 会先拒掉其他目标架构，这里仍按传入的架构取值，
 * 以免某天再次放开目标架构时静默放一个没进包的二进制过去。
 */
export function assertRipgrepBinaryForPackaging({
  architecture = process.arch,
  projectRoot: targetProjectRoot = projectRoot
} = {}) {
  const root = ripgrepBinariesRoot(targetProjectRoot);
  const lockPath = resolve(root, 'ripgrep.lock.json');
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(`Missing or unreadable ripgrep lock: ${lockPath} (${error instanceof Error ? error.message : String(error)})`);
  }
  const entry = lock?.architectures?.[architecture];
  if (entry === undefined) {
    throw new Error(`ripgrep.lock.json declares no binary for ${architecture}: ${lockPath}`);
  }
  if (typeof entry.binarySha256 !== 'string' || entry.binarySha256.length === 0) {
    throw new Error(`ripgrep.lock.json has no binarySha256 for ${architecture}; the binary would ship unverified: ${lockPath}`);
  }
  const binaryPath = resolve(root, entry.platformDir, 'rg');
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    throw new Error(`Missing bundled ripgrep binary for packaging: ${binaryPath}. Run pnpm sync:ripgrep --arch ${architecture}`);
  }
  const digest = packagedToolchainSha256(binaryPath);
  if (digest !== entry.binarySha256) {
    throw new Error(`Bundled ripgrep binary does not match ${lockPath}: ${binaryPath} (sha256 ${digest})`);
  }
}

export function assertOnnxRuntimeNodeForPackaging({
  architecture = process.arch,
  projectRoot: targetProjectRoot = projectRoot
} = {}) {
  if (architecture !== 'arm64') {
    throw new Error(`ONNX Runtime packaging is configured only for darwin/arm64, got ${architecture}.`);
  }
  const packagePath = resolve(targetProjectRoot, 'node_modules', 'onnxruntime-node', 'package.json');
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`Missing or unreadable onnxruntime-node package: ${packagePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (metadata.version !== '1.22.0-rev') {
    throw new Error(`Expected onnxruntime-node@1.22.0-rev, found ${String(metadata.version)} at ${packagePath}.`);
  }
  const nativeRoot = resolve(targetProjectRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'darwin', architecture);
  const nativePaths = [
    resolve(nativeRoot, 'libonnxruntime.1.22.0.dylib'),
    resolve(nativeRoot, 'onnxruntime_binding.node')
  ];
  for (const nativePath of nativePaths) {
    if (!existsSync(nativePath) || !statSync(nativePath).isFile() || statSync(nativePath).size === 0) {
      throw new Error(`Missing ONNX Runtime native file for darwin/${architecture}: ${nativePath}`);
    }
    const result = spawnSync('/usr/bin/lipo', ['-archs', nativePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) {
      throw new Error(`Could not inspect ONNX Runtime architecture for ${nativePath}: ${result.error?.message ?? result.stderr}`);
    }
    const architectures = result.stdout.trim().split(/\s+/u);
    if (architectures.length !== 1 || architectures[0] !== architecture) {
      throw new Error(`ONNX Runtime native file must contain only ${architecture}: ${nativePath} (${result.stdout.trim()})`);
    }
  }
  return { version: metadata.version, architecture, nativeFiles: nativePaths };
}

function packagedToolchainSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const packagedResearchLeftoverNames = new Set([
  'PyObjCTest',
  'pip',
  'debugpy',
  'pydevd_plugins',
  'jedi',
  'parso',
  'IPython',
  'ipykernel',
  'ipykernel_launcher.py',
  'ipython_pygments_lexers.py',
  'matplotlib_inline',
  'jupyter.py',
  'jupyter_client',
  'jupyter_core',
  'nbclient',
  'nbformat',
  'tornado',
  'zmq',
  'prompt_toolkit',
  'pexpect',
  'ptyprocess',
  'appnope',
  'asttokens',
  'executing',
  'stack_data',
  'pure_eval',
  'traitlets',
  'comm',
  'fastjsonschema',
  'nest_asyncio2.py',
  'faker',
  'polyfactory'
]);

function isPackagedResearchLeftoverPart(part) {
  const lower = part.toLowerCase();
  if (lower === '__pycache__') return true;
  for (const name of packagedResearchLeftoverNames) {
    const leftover = name.toLowerCase();
    if (
      lower === leftover
      || (lower.startsWith(`${leftover}-`) && (lower.endsWith('.dist-info') || lower.endsWith('.egg-info')))
    ) {
      return true;
    }
  }
  return false;
}

export function isExcludedPackagedResearchPath(relativePath) {
  if (relativePath === 'models' || relativePath.startsWith('models/')) return true;
  if (relativePath.endsWith('.pyc')) return true;
  if (relativePath === 'python/include' || relativePath.startsWith('python/include/')) return true;
  return relativePath.split('/').some((part) => isPackagedResearchLeftoverPart(part));
}

/**
 * 读一个 JSON 文件，把「文件坏了」变成带错误码的 Error。
 * 打包校验是最后一道门，报错要说清楚哪个文件哪一步。
 */
function readJsonFile(path, code) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${code}: cannot read ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${code}: invalid JSON in ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

export function assertLiveResearchToolchainForPackaging({
  architecture = process.arch,
  projectRoot: targetProjectRoot = projectRoot
} = {}) {
  const root = liveResearchToolchainPath(architecture, targetProjectRoot);
  const required = [
    'manifest.json',
    'bin/tectonic',
    'bin/uv',
    'bin/vale',
    'typescript-experiment-runner.mts',
    'python/bin/python3',
    'tex/bundle.zip',
    'licenses/python-packages.json'
  ];
  for (const relativePath of required) {
    const fullPath = resolve(root, relativePath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      const prepareScript = resolve(targetProjectRoot, 'scripts/research/prepare.ts');
      throw new Error(
        `Missing research toolchain for packaging: ${relativePath}. Prepare ${root} before package:mac with: rtk proxy node ${prepareScript} --arch ${architecture} --output ${root}`
      );
    }
  }
  // 版本也要对一遍。只看文件在不在的话，一套旧的 3.12.14/0.12.10 工具链能一路打包成功，
  // 然后在运行时被 `research_toolchain_version_mismatch` 拒掉——整个科研插件不可用，
  // 而且要等用户装上才发现。这里按 lock 里该架构声明的工具集逐项比。
  const manifest = readJsonFile(resolve(root, 'manifest.json'), 'research_toolchain_manifest_invalid');
  const sources = researchRuntimeSourcePath(targetProjectRoot);
  const lock = readJsonFile(resolve(sources, 'tools.lock.json'), 'research_toolchain_lock_invalid');
  const declaredTools = lock?.architectures?.[String(architecture)];
  if (typeof declaredTools !== 'object' || declaredTools === null) {
    throw new Error(`Research toolchain lock declares no tools for architecture ${architecture}`);
  }
  for (const name of Object.keys(declaredTools)) {
    const expected = lock[`${name}Version`];
    const actual = manifest?.versions?.[name];
    if (typeof expected !== 'string' || expected.length === 0 || actual !== expected) {
      const prepareScript = resolve(targetProjectRoot, 'scripts/research/prepare.ts');
      throw new Error(
        `Research toolchain ${name} version mismatch for packaging: manifest=${String(actual)} lock=${String(expected)}. Rebuild ${root} with: rtk proxy node ${prepareScript} --arch ${architecture} --output ${root}`
      );
    }
  }
}

function removeExcludedPackagedResearchPaths(root) {
  const queue = [''];
  while (queue.length > 0) {
    const relativeDir = queue.pop();
    const directory = relativeDir === '' ? root : join(root, relativeDir);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const fullPath = join(directory, entry.name);
      if (isExcludedPackagedResearchPath(relativePath)) {
        rmSync(fullPath, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(relativePath);
    }
  }
}

function collectPackagedResearchEntries(root, previousEntries) {
  const previous = new Map(previousEntries.map((entry) => [entry.path, entry]));
  const entries = [];
  const visit = (relativeDir) => {
    const directory = relativeDir === '' ? root : join(root, relativeDir);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (relativePath === 'manifest.json' || isExcludedPackagedResearchPath(relativePath)) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(relativePath);
        continue;
      }
      const info = lstatSync(fullPath);
      if (info.isSymbolicLink()) {
        const previousEntry = previous.get(relativePath);
        if (previousEntry?.type === 'symlink') {
          entries.push(previousEntry);
          continue;
        }
        const target = readlinkSync(fullPath);
        if (target.startsWith('/')) {
          throw new Error(`Packaged research toolchain symlink must be relative: ${relativePath}`);
        }
        entries.push({ path: relativePath, type: 'symlink', target });
        continue;
      }
      if (!info.isFile()) {
        throw new Error(`Packaged research toolchain file type invalid: ${relativePath}`);
      }
      const previousEntry = previous.get(relativePath);
      const executable = (info.mode & 0o100) !== 0;
      const reuse =
        previousEntry?.type === 'file' &&
        previousEntry.size === info.size &&
        previousEntry.executable === executable;
      entries.push(
        reuse
          ? previousEntry
          : {
              path: relativePath,
              type: 'file',
              size: info.size,
              sha256: packagedToolchainSha256(fullPath),
              executable
            }
      );
    }
  };
  visit('');
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
}

export function finalizePackagedResearchToolchain({
  resourcesDir,
  architecture = process.arch
}) {
  const root = researchToolchainResourcePath(resourcesDir);
  rmSync(resolve(root, 'figure.py'), { force: true });
  removeExcludedPackagedResearchPaths(root);
  const manifestPath = resolve(root, 'manifest.json');
  const manifest = readJsonFile(manifestPath, 'packaged_toolchain_manifest_invalid');
  if (manifest.platform !== 'darwin' || manifest.architecture !== architecture) {
    throw new Error(`Packaged research toolchain architecture mismatch: ${manifest.architecture}`);
  }
  const lockHashes = { ...manifest.lockHashes };
  delete lockHashes['figure.py'];
  delete lockHashes['bibliography.py'];
  const next = {
    ...manifest,
    lockHashes,
    entries: collectPackagedResearchEntries(root, Array.isArray(manifest.entries) ? manifest.entries : [])
  };
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export function verifyPackagedResearchToolchain({
  resourcesDir,
  architecture = process.arch
}) {
  const root = researchToolchainResourcePath(resourcesDir);
  const required = [
    'manifest.json',
    'bin/tectonic',
    'bin/uv',
    'bin/vale',
    'typescript-experiment-runner.mts',
    'python/bin/python3',
    'tex/bundle.zip',
    // Vale 的配置与规则集与二进制同等重要：少了它们 `lintProse()` 会在运行时报错，
    // 而只有这条打包断言能在 `afterPack` 阶段把它拦住。
    'vale/.vale.ini',
    'vale/styles/RocAcademic/Hedging.yml',
    'vale/styles/RocAcademicZh/Hedging.yml',
    'vale/styles/config/vocabularies/Roc/accept.txt',
    'licenses/README.md',
    'licenses/sources.json',
    'licenses/python-packages.json',
    'licenses/tectonic-MIT.txt',
    'licenses/uv-MIT.txt',
    'licenses/uv-APACHE.txt',
    'licenses/vale-MIT.txt',
  ];
  for (const relativePath of required) {
    const fullPath = resolve(root, relativePath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      throw new Error(`Missing packaged research toolchain file: ${relativePath}`);
    }
  }
  const manifest = readJsonFile(resolve(root, 'manifest.json'), 'packaged_toolchain_manifest_invalid');
  if (manifest.platform !== 'darwin' || manifest.architecture !== architecture) {
    throw new Error(`Packaged research toolchain architecture mismatch: ${manifest.architecture}`);
  }
  const licenses = readJsonFile(resolve(root, 'licenses/python-packages.json'), 'packaged_toolchain_licenses_invalid');
  if (!Array.isArray(licenses) || licenses.length === 0) {
    throw new Error('Packaged research toolchain is missing python license records.');
  }
  if (existsSync(resolve(root, 'models'))) {
    throw new Error('Packaged research toolchain must not include models.');
  }
  const leftover = packagedResearchLeftover(root);
  if (leftover !== null) {
    throw new Error(`Packaged research toolchain must not include ${leftover}.`);
  }
  if (existsSync(resolve(root, 'figure.py'))) {
    throw new Error('Legacy figure renderer must not be packaged.');
  }
}

function packagedPythonSiteLeftover(root) {
  const lib = resolve(root, 'python/lib');
  if (!existsSync(lib)) return null;
  for (const entry of readdirSync(lib, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('python')) continue;
    const site = resolve(lib, entry.name, 'site-packages');
    if (!existsSync(site)) continue;
    for (const installed of readdirSync(site)) {
      if (isPackagedResearchLeftoverPart(installed)) return installed;
    }
  }
  return null;
}

function packagedResearchLeftover(root) {
  const siteLeftover = packagedPythonSiteLeftover(root);
  if (siteLeftover !== null) return siteLeftover;
  const queue = [''];
  while (queue.length > 0) {
    const relativeDir = queue.pop();
    const directory = relativeDir === '' ? root : join(root, relativeDir);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (isExcludedPackagedResearchPath(relativePath)) return relativePath;
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(relativePath);
    }
  }
  return null;
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

export function preparePackagedNodePty({ resourcesDir }) {
  prepareNodePtyHelpers({
    packageRoot: resolve(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty')
  });
}

export function prepareWorkspaceNodePty({ projectRoot: targetProjectRoot = projectRoot } = {}) {
  prepareNodePtyHelpers({ packageRoot: resolve(targetProjectRoot, 'node_modules', 'node-pty') });
}

function prepareNodePtyHelpers({ packageRoot }) {
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
