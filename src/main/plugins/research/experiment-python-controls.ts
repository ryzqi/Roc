import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { readResearchFile, researchContentHash, researchPath } from './research-files';

export type PythonEnvironmentControls = {
  contractVersion: 1;
  selectedExecutable: string;
  executable: string;
  executableHash: string;
  prefix: string;
  basePrefix: string;
  modulePaths: string[];
  packagePath: string;
  codeRoots: string[];
  controls: Array<{ path: string; sha256: string }>;
};

/**
 * Preflight an explicitly selected standalone CPython 3.14 or its standard venv.
 * Path discovery is not user authorization and never launches the interpreter.
 */
export async function discoverPythonEnvironmentControls(selectedPath: string, signal: AbortSignal): Promise<PythonEnvironmentControls> {
  signal.throwIfAborted();
  if (!isAbsolute(selectedPath) || /[\u0000-\u001f]/u.test(selectedPath)) throw new Error('research_python_interpreter_path_invalid');
  const selectedBin = await realpath(dirname(selectedPath));
  if (basename(selectedBin) !== 'bin' || !/^python(?:3(?:\.14)?)?$/u.test(basename(selectedPath))) {
    throw new Error('research_python_interpreter_layout_unsupported');
  }
  const selectedExecutable = join(selectedBin, basename(selectedPath));
  const executable = await realpath(selectedExecutable);
  if (basename(executable) !== 'python3.14' || basename(dirname(executable)) !== 'bin') {
    throw new Error('research_python_interpreter_layout_unsupported');
  }
  const prefix = dirname(selectedBin), basePrefix = dirname(dirname(executable));
  const bins = [...new Set([selectedBin, dirname(executable)])];
  const libraries = [...new Set([join(prefix, 'lib'), join(basePrefix, 'lib')])];
  // ._pth can force import site even with -I -S; refuse it before any Python code.
  for (const directory of [...bins, ...libraries]) await rejectPathOverrides(directory, signal);
  for (const bin of bins) if (await present(join(bin, 'pyvenv.cfg'))) throw new Error('research_python_venv_layout_unsupported');
  const baseConfig = join(basePrefix, 'pyvenv.cfg');
  if (await present(baseConfig)) throw new Error('research_python_base_config_unsupported');

  const bytes = await readResearchFile(basePrefix, relative(basePrefix, executable), 64 * 1024 ** 2);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 2) {
    throw new Error('research_python_interpreter_binary_unsupported');
  }
  const controls: PythonEnvironmentControls['controls'] = [];
  if (prefix !== basePrefix) {
    const configPath = join(prefix, 'pyvenv.cfg');
    const config = await readResearchFile(prefix, 'pyvenv.cfg', 64 * 1024);
    const fields = parseVenvConfig(config.toString('utf8'));
    if (fields.get('include-system-site-packages') !== 'false') throw new Error('research_python_system_packages_unsupported');
    const home = fields.get('home');
    if (home === undefined || !isAbsolute(home) || await realpath(home) !== dirname(executable)) {
      throw new Error('research_python_venv_home_mismatch');
    }
    const version = fields.get('version');
    if (version === undefined || !/^3\.14\.\d+$/u.test(version)) throw new Error('research_python_venv_version_unsupported');
    controls.push({ path: configPath, sha256: researchContentHash(config) });
  }
  const standardLibrary = await researchPath(basePrefix, 'lib/python3.14');
  const dynamicLibrary = await researchPath(basePrefix, 'lib/python3.14/lib-dynload');
  const packagePath = await researchPath(prefix, 'lib/python3.14/site-packages');
  for (const path of [standardLibrary, dynamicLibrary, packagePath]) {
    if (!(await lstat(path)).isDirectory()) throw new Error('research_python_library_directory_required');
  }
  await researchPath(basePrefix, 'lib/python3.14/encodings/__init__.py');
  await researchPath(basePrefix, 'lib/python3.14/os.py');
  signal.throwIfAborted();
  return { contractVersion: 1, selectedExecutable, executable, executableHash: researchContentHash(bytes), prefix, basePrefix,
    modulePaths: [join(basePrefix, 'lib/python314.zip'), standardLibrary, dynamicLibrary], packagePath,
    codeRoots: [...new Set([...bins, ...libraries])].sort(), controls };
}

async function rejectPathOverrides(directory: string, signal: AbortSignal): Promise<void> {
  const actual = await realpath(directory);
  if (actual !== directory || !(await lstat(actual)).isDirectory()) throw new Error('research_python_library_layout_unsupported');
  let count = 0;
  for await (const entry of await opendir(actual)) {
    signal.throwIfAborted();
    if (++count > 4096) throw new Error('research_python_control_entry_limit');
    if (entry.name.toLowerCase().endsWith('._pth')) throw new Error('research_python_path_override_unsupported');
  }
}

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseVenvConfig(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    const separator = line.indexOf('='), name = line.slice(0, separator).trim(), value = line.slice(separator + 1).trim();
    if (separator < 1 || !['home', 'include-system-site-packages', 'version', 'executable', 'command', 'prompt'].includes(name)
      || value === '' || fields.has(name)) throw new Error('research_python_venv_config_invalid');
    fields.set(name, value);
  }
  return fields;
}
