import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Main owns discovery; renderer and model arguments never supply interpreter paths. */
export async function discoverProjectPythonExecutables(workspace: string, signal: AbortSignal,
  home = homedir(), searchPath = process.env.PATH ?? ''): Promise<string[]> {
  const candidates = ['.venv', 'venv'].flatMap(directory =>
    ['python3.14', 'python3', 'python'].map(name => join(workspace, directory, 'bin', name)));
  const uvRoot = join(home, '.local/share/uv/python');
  try {
    const installations = (await readdir(uvRoot)).filter(name => /^cpython-3\.14\.\d+-macos-aarch64-none$/u.test(name))
      .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
    candidates.push(...installations.map(name => join(uvRoot, name, 'bin/python3.14')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const directory of [join(home, '.local/bin'), '/opt/homebrew/opt/python@3.14/bin',
    '/opt/homebrew/bin', '/usr/local/bin', '/Library/Frameworks/Python.framework/Versions/3.14/bin',
    ...searchPath.split(':').filter(isAbsolute)]) {
    candidates.push(join(directory, 'python3.14'), join(directory, 'python3'));
  }
  const found: string[] = [];
  for (const candidate of new Set(candidates)) {
    signal.throwIfAborted();
    try { await access(candidate, constants.X_OK); found.push(candidate); }
    catch (error) {
      if (!['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return found;
}
