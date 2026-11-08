import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { EVAL_ROOT, contained, directory, fail, hash, readJson, sha256, writeJson } from './common.mjs';
import { command } from './process.mjs';

function environmentInventory(root) {
  const files = [];
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      if (name === '__pycache__') continue;
      const child = join(path, name), stat = lstatSync(child), key = relative(root, child);
      if (key === 'environment.json') continue;
      if (stat.isSymbolicLink()) files.push({ path: key, link: readlinkSync(child), target: realpathSync(child) });
      else if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) files.push({ path: key, sha256: sha256(readFileSync(child)) });
      else fail('environment', 'python_environment_special_file');
    }
  }
  visit(root); return files;
}
const runtimeProbe = 'import json,sys,sysconfig; print(json.dumps(dict(version=sys.version,basePrefix=sys.base_prefix,stdlib=sysconfig.get_path("stdlib"),executable=sys.executable)))';
export async function preparePython(name, python = 'python3', requirements) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) fail('policy', 'environment_name_invalid');
  const root = directory(join(EVAL_ROOT, 'environments'), name);
  const probe = await command(python, ['-I', '-B', '-c', 'import os,sys; print(os.path.realpath(sys.executable))']);
  if (probe.exitCode !== 0) fail('environment', 'python_interpreter_unavailable');
  let result = await command(probe.stdout.trim(), ['-m', 'venv', '--copies', root], { timeoutMs: 120000 });
  if (result.exitCode !== 0) fail('environment', 'python_venv_creation_failed');
  const executable = join(root, 'bin/python');
  if (requirements) {
    result = await command(executable, ['-I', '-m', 'pip', 'install', '--require-hashes', '-r', resolve(requirements)], { timeoutMs: 600000 });
    writeJson(join(root, 'install.json'), result);
    if (result.exitCode !== 0) fail('environment', 'python_requirements_install_failed');
  }
  result = await command(executable, ['-I', '-B', '-c', runtimeProbe]);
  if (result.exitCode !== 0) fail('environment', 'python_probe_failed');
  const runtime = JSON.parse(result.stdout);
  const identity = { runtime, executableSha256: sha256(readFileSync(realpathSync(executable))), inventory: environmentInventory(root),
    requirementsSha256: requirements ? sha256(readFileSync(requirements)) : null, platform: process.platform, arch: process.arch };
  writeJson(join(root, 'environment.json'), { ...identity, identity: hash(identity) });
  return join(root, 'environment.json');
}
export function loadPython(lockPath) {
  // An evaluation environment can never be an application environment or a global venv.
  const path = contained(join(EVAL_ROOT, 'environments'), realpathSync(contained(join(EVAL_ROOT, 'environments'), resolve(lockPath))));
  const root = dirname(path), lock = readJson(path), { identity, ...content } = lock;
  if (hash(content) !== identity || hash(environmentInventory(root)) !== hash(lock.inventory)
    || sha256(readFileSync(realpathSync(join(root, 'bin/python')))) !== lock.executableSha256) fail('environment', 'python_environment_changed');
  return { root, python: join(root, 'bin/python'), lock };
}

export function pythonPolicy(environment, readRoots, writeRoot) {
  const quote = path => JSON.stringify(realpathSync(path));
  return `(version 1)(deny default)(import "system.sb")
    (allow process-exec (literal ${quote(environment.python)}))
    (allow sysctl-read file-read-metadata)
    (deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))
    (allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/usr/share")
      ${[environment.root, environment.lock.runtime.basePrefix, environment.lock.runtime.stdlib, ...readRoots].map(p => `(subpath ${quote(p)})`).join(' ')})
    (allow file-read* file-write* (subpath ${quote(writeRoot)}))
    (allow file-read* file-write-data (literal "/dev/null") (literal "/dev/urandom"))
    (allow signal (target self))`;
}
export async function runPython(environment, script, args, { readRoots, writeRoot, directory: evidenceDir, signal, timeoutMs = 120000, maxBytes = 1048576 }) {
  if (process.platform !== 'darwin') fail('environment', 'macos_sandbox_required');
  const policy = pythonPolicy(environment, readRoots, writeRoot);
  writeFileSync(join(evidenceDir, 'sandbox.sb'), policy, { flag: 'wx', mode: 0o600 });
  const wrapper = `import resource,runpy,sys,os
resource.setrlimit(resource.RLIMIT_CPU, (${Math.ceil(timeoutMs / 1000)}, ${Math.ceil(timeoutMs / 1000) + 1}))
resource.setrlimit(resource.RLIMIT_FSIZE, (67108864,67108864))
resource.setrlimit(resource.RLIMIT_NOFILE, (128,128))
sys.path.insert(0,os.path.dirname(sys.argv[1]))
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name='__main__')`;
  const result = await command('/usr/bin/sandbox-exec', ['-p', policy, environment.python, '-I', '-B', '-c', wrapper, script, ...args], {
    cwd: writeRoot, signal, timeoutMs, maxBytes,
    env: { PATH: '/usr/bin:/bin', HOME: writeRoot, TMPDIR: writeRoot, LANG: 'en_US.UTF-8',
      MPLCONFIGDIR: join(writeRoot, '.matplotlib'), OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' }
  });
  writeJson(join(evidenceDir, 'process.json'), { ...result, processGroupGone: true });
  return result;
}
