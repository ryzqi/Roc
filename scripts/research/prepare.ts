import { constants } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { convertTexBundle, extractToolArchive, parseTexBundleFileList } from './archive-utils.ts';
import { downloadVerified, fileSha256 } from './download-asset.ts';
import { collectPythonLicenses } from './collect-licenses.ts';
import { fetchModels } from './fetch-models.ts';
import { verifyManifest, writeManifest } from './manifest.ts';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCES = join(PROJECT_ROOT, 'resources/research-runtime');
const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const LOCK_FILES = ['pyproject.toml', 'uv.lock', 'tools.lock.json', 'models.lock.json', 'tex-bundle-files.txt'] as const;
const SCRIPT_FILES = [
  'prepare.ts',
  'archive-utils.ts',
  'download-asset.ts',
  'fetch-models.ts',
  'manifest.ts',
  'smoke.ts',
  'build-r-process.ts',
  'collect-licenses.ts'
] as const;
const DARWIN_O_EXLOCK = 0x20;
const PROXY_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE'
];
const PYTHON_WRAPPER = "#!/bin/sh\n'''exec' \"$(dirname \"$0\")/python3\" \"$0\" \"$@\"\n' '''\n";
const PYTHON_EXEC_MARKER = "'''exec' ";

type ToolsLock = {
  schemaVersion: number;
  pythonVersion: string;
  uvVersion: string;
  tectonicVersion: string;
  texBundle: { url: string; sha256: string; size: number; zipSha256: string };
  architectures: Record<string, Record<string, { url: string; sha256: string }>>;
};

function fail(code: string): never {
  throw new Error(code);
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function hostArchitecture(): 'arm64' | 'x64' {
  if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64')) {
    fail('research_toolchain_build_requires_matching_macos_host');
  }
  return process.arch;
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

export function buildEnvironment(cache: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PROXY_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.UV_CACHE_DIR = join(cache, 'uv');
  environment.UV_NO_PROGRESS = '1';
  environment.UV_PYTHON_DOWNLOADS = 'never';
  environment.PYTHONNOUSERSITE = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  environment.HF_HUB_DISABLE_IMPLICIT_TOKEN = '1';
  environment.HF_HUB_DISABLE_TELEMETRY = '1';
  environment.HF_HUB_DISABLE_XET = '1';
  return environment;
}

function extractBuildConstraints(pyproject: string): string[] {
  const match = /(?:^|\n)build-constraint-dependencies\s*=\s*\[(.*?)\]/su.exec(pyproject);
  if (match === null) fail('research_tools_lock_invalid');
  const items = [...match[1].matchAll(/"((?:\\.|[^"\\])+)"/gu)].map((item) => item[1]);
  if (items.length === 0) fail('research_tools_lock_invalid');
  return items;
}

async function copyPreservingMode(source: string, destination: string): Promise<void> {
  await copyFile(source, destination);
  const info = await lstat(source);
  await chmod(destination, info.mode & 0o777);
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(full);
      else files.push(full);
    }
  };
  await visit(root);
  return files;
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of await walkFiles(root)) {
    const info = await lstat(file);
    if (!info.isSymbolicLink() && info.isFile() && file.split(sep).pop() === name) found.push(file);
  }
  return found;
}

async function runCommand(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; capture?: boolean; discardStdout?: boolean }
): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['ignore', options.capture === true ? 'pipe' : options.discardStdout === true ? 'ignore' : 'inherit', options.capture === true ? 'pipe' : 'inherit']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(detail === '' ? `research_toolchain_command_failed:${command}` : detail));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function withPrepareLock(lockPath: string, work: () => Promise<void>): Promise<void> {
  if ((await pathInfo(lockPath))?.isSymbolicLink()) fail('research_toolchain_lock_symlink');
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | DARWIN_O_EXLOCK;
  let handle;
  try {
    handle = await open(lockPath, flags, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN' || (error as NodeJS.ErrnoException).code === 'EWOULDBLOCK') {
      fail('research_toolchain_locked');
    }
    throw error;
  }
  try {
    await work();
  } finally {
    await handle.close();
  }
}

function firstLines(bytes: Buffer): { first: Buffer; second: Buffer } {
  const firstEnd = bytes.indexOf(0x0a);
  const first = bytes.subarray(0, firstEnd === -1 ? Math.min(bytes.length, 4096) : Math.min(firstEnd + 1, 4096));
  if (firstEnd === -1 || first.toString('latin1') !== '#!/bin/sh\n') return { first, second: Buffer.alloc(0) };
  const rest = bytes.subarray(firstEnd + 1);
  const secondEnd = rest.indexOf(0x0a);
  const second = rest.subarray(0, secondEnd === -1 ? Math.min(rest.length, 4096) : Math.min(secondEnd + 1, 4096));
  return { first, second };
}

export async function portablePython(prefix: string): Promise<void> {
  const bin = join(prefix, 'bin');
  const prefixBytes = Buffer.from(prefix);
  const marker = Buffer.from(PYTHON_EXEC_MARKER);
  for (const entry of await readdir(bin, { withFileTypes: true })) {
    const script = join(bin, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const bytes = await readFile(script);
    const { first, second } = firstLines(bytes);
    if (!first.subarray(0, 2).equals(Buffer.from('#!'))) continue;
    const wrapped = second.subarray(0, marker.length).equals(marker) && second.includes(prefixBytes);
    if (!first.includes(prefixBytes) && !wrapped) continue;
    const text = bytes.toString('utf8');
    const body = wrapped ? text.split('\n').slice(3).join('\n') : text.split('\n').slice(1).join('\n');
    const mode = (await lstat(script)).mode;
    await writeFile(script, PYTHON_WRAPPER + body, 'utf8');
    await chmod(script, mode & 0o777);
  }
  const prefixRoot = await realpath(prefix);
  for (const file of await walkFiles(prefix)) {
    if (!file.endsWith('.pyc')) continue;
    const info = await lstat(file);
    if (info.isSymbolicLink()) fail('research_python_bytecode_path_invalid');
    const resolved = await realpath(file);
    if (resolved !== prefixRoot && !resolved.startsWith(`${prefixRoot}${sep}`)) fail('research_python_bytecode_path_invalid');
    await rm(file);
  }
}

export async function computeLockHashes(): Promise<Record<string, string>> {
  const lockHashes: Record<string, string> = {};
  for (const name of LOCK_FILES) lockHashes[name] = await fileSha256(join(SOURCES, name));
  const runtimeFiles = (await readdir(SOURCES)).filter((name) => name.endsWith('.py')).sort();
  for (const name of runtimeFiles) lockHashes[name] = await fileSha256(join(SOURCES, name));
  const licenseRoot = join(SOURCES, 'licenses');
  if (await pathInfo(licenseRoot) !== null) {
    for (const file of (await walkFiles(licenseRoot)).sort()) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      lockHashes[relative(SOURCES, file).split(sep).join('/')] = await fileSha256(file);
    }
  }
  for (const name of SCRIPT_FILES) lockHashes[`scripts/${name}`] = await fileSha256(join(SCRIPTS, name));
  return lockHashes;
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export async function prepare(architecture: string, outputPath: string, cachePath: string, modelCachePath: string): Promise<void> {
  if (architecture !== hostArchitecture()) fail('research_toolchain_build_requires_matching_macos_host');
  if ((await pathInfo(outputPath))?.isSymbolicLink()
      || (await pathInfo(cachePath))?.isSymbolicLink()
      || (await pathInfo(modelCachePath))?.isSymbolicLink()) {
    fail('research_toolchain_directory_symlink');
  }
  const output = resolve(outputPath);
  const cache = resolve(cachePath);
  const modelCache = resolve(modelCachePath);
  if (overlaps(output, cache) || overlaps(output, modelCache)) fail('research_toolchain_output_overlaps_cache');
  const lockHashes = await computeLockHashes();
  const tools = JSON.parse(await readFile(join(SOURCES, 'tools.lock.json'), 'utf8')) as ToolsLock;
  if (tools.schemaVersion !== 1) fail('research_tools_lock_invalid');
  if (await pathInfo(output) !== null) {
    const existing = await verifyManifest(output);
    if (!sameRecord(existing.lockHashes, lockHashes) || existing.architecture !== architecture) {
      fail('research_toolchain_existing_sources_differ_use_new_output');
    }
    console.log(`已有工具链校验通过：${output}`);
    return;
  }
  await mkdir(cache, { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  const environment = buildEnvironment(cache);
  await withPrepareLock(join(cache, 'prepare.lock'), async () => {
    const staging = await mkdtemp(join(dirname(output), '.research-toolchain-'));
    try {
      const root = join(staging, 'toolchain');
      await mkdir(join(root, 'bin'), { recursive: true });
      const archTools = tools.architectures[architecture];
      if (archTools === undefined) fail('research_tools_lock_invalid');
      for (const [name, item] of Object.entries(archTools)) {
        const archive = await downloadVerified(item.url, item.sha256, join(cache, `${name}-${architecture}.tar.gz`));
        const extracted = join(staging, name);
        await extractToolArchive(archive, extracted);
        if (name === 'python') {
          await rename(join(extracted, 'python'), join(root, 'python'));
        } else {
          const candidates = await findNamedFiles(extracted, name);
          if (candidates.length !== 1) fail(`research_tool_binary_ambiguous:${name}`);
          await copyPreservingMode(candidates[0], join(root, 'bin', name));
        }
      }
      const python = join(root, 'python/bin/python3');
      const uv = join(root, 'bin/uv');
      const requirements = join(root, 'requirements.txt');
      const constraints = join(root, 'build-constraints.txt');
      await writeFile(constraints, `${extractBuildConstraints(await readFile(join(SOURCES, 'pyproject.toml'), 'utf8')).join('\n')}\n`);
      await runCommand(uv, [
        'export', '--locked', '--no-dev', '--no-emit-project', '--no-header', '--no-annotate',
        '--project', SOURCES, '--python', python, '--output-file', requirements
      ], { env: environment, discardStdout: true });
      await runCommand(uv, [
        'pip', 'sync', '--python', python, '--require-hashes', '--strict', '--link-mode', 'copy',
        '--default-index', 'https://pypi.org/simple', '--build-constraints', constraints, requirements
      ], { env: environment });
      await fetchModels(join(SOURCES, 'models.lock.json'), modelCache);
      const bundle = tools.texBundle;
      const archive = await downloadVerified(bundle.url, bundle.sha256, join(cache, 'tlextras-2022.0r0.tar'), {
        expectedSize: bundle.size
      });
      const fileList = parseTexBundleFileList(await readFile(join(SOURCES, 'tex-bundle-files.txt'), 'utf8'));
      const cachedZip = join(cache, 'tex-bundle.zip');
      if (await pathInfo(cachedZip) !== null && await fileSha256(cachedZip) !== bundle.zipSha256) {
        await rm(cachedZip);
      }
      if (await pathInfo(cachedZip) === null) await convertTexBundle(archive, cachedZip, fileList);
      if (await fileSha256(cachedZip) !== bundle.zipSha256) fail('research_tex_zip_hash_mismatch');
      await mkdir(join(root, 'tex'));
      await copyPreservingMode(cachedZip, join(root, 'tex/bundle.zip'));
      for (const name of (await readdir(SOURCES)).filter((item) => item.endsWith('.py'))) {
        await copyPreservingMode(join(SOURCES, name), join(root, name));
      }
      await mkdir(join(root, 'locks'));
      for (const name of LOCK_FILES) await copyPreservingMode(join(SOURCES, name), join(root, 'locks', name));
      await cp(join(SOURCES, 'licenses'), join(root, 'licenses'), { recursive: true, preserveTimestamps: true });
      const collected = await collectPythonLicenses(root);
      await writeFile(join(root, 'licenses/python-packages.json'), `${JSON.stringify(collected, null, 2)}\n`, 'utf8');
      await portablePython(join(root, 'python'));
      const versions = { python: tools.pythonVersion, uv: tools.uvVersion, tectonic: tools.tectonicVersion };
      const manifest = await writeManifest(root, { architecture, versions, lockHashes });
      await rename(root, output);
      console.log(`科研工具链已准备：${output}（${manifest.entries.length} 个文件或链接）`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arch: { type: 'string' },
      output: { type: 'string' },
      cache: { type: 'string', default: join(PROJECT_ROOT, '.runtime/research-downloads') },
      models: { type: 'string', default: join(PROJECT_ROOT, '.runtime/research-models') }
    },
    strict: true
  });
  if (values.arch !== 'arm64' && values.arch !== 'x64') fail('research_toolchain_build_requires_matching_macos_host');
  if (values.output === undefined || values.output === '') fail('research_toolchain_output_required');
  await prepare(values.arch, values.output, values.cache ?? join(PROJECT_ROOT, '.runtime/research-downloads'),
    values.models ?? join(PROJECT_ROOT, '.runtime/research-models'));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
