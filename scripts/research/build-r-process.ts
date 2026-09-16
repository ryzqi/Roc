import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`research_r_process_build_failed:${command}`));
      else resolvePromise();
    });
  });
}

export async function buildRProcess(root = PROJECT_ROOT): Promise<string> {
  const source = join(root, 'resources/research-runtime/r-process.c');
  const destination = join(root, 'resources/research-runtime/r-process.lock.json');
  const sourceBytes = await readFile(source);
  const result: {
    sourceHash: string;
    architectures: string[];
    sha256?: string;
    data?: string;
  } = {
    sourceHash: createHash('sha256').update(sourceBytes).digest('hex'),
    architectures: ['arm64', 'x64']
  };
  const temporary = await mkdtemp(join(tmpdir(), 'roc-r-process-build-'));
  try {
    const slices: string[] = [];
    for (const [architecture, target] of [['arm64', 'arm64'], ['x64', 'x86_64']] as const) {
      const library = join(temporary, `roc-research-r-process-${architecture}.dylib`);
      await run('/usr/bin/xcrun', [
        'clang', '-arch', target, '-mmacosx-version-min=11.0', '-dynamiclib', '-O2', '-g0', '-fvisibility=hidden',
        '-Wall', '-Wextra', '-Werror', '-Wl,-install_name,@rpath/roc-research-r-process.dylib', source, '-o', library
      ]);
      slices.push(library);
    }
    const library = join(temporary, 'roc-research-r-process.dylib');
    await run('/usr/bin/xcrun', ['lipo', '-create', ...slices, '-output', library]);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', library]);
    const data = await readFile(library);
    result.sha256 = createHash('sha256').update(data).digest('hex');
    result.data = data.toString('base64');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(destination);
  return destination;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildRProcess();
}
