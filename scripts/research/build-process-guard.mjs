import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const source = join(root, 'resources/research-runtime/process-guard.c');
const temporary = await mkdtemp(join(tmpdir(), 'roc-process-guard-build-'));
try {
  const binary = join(temporary, 'roc-research-process-guard');
  await run('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=11.0',
    '-O2', '-g0', '-Wall', '-Wextra', '-Werror', source, '-o', binary]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'roc-research-process-guard', binary]);
  const bytes = await readFile(binary);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const lock = {
    sourceHash: hash(await readFile(source)), architectures: ['arm64'],
    sha256: hash(bytes), data: bytes.toString('base64')
  };
  await writeFile(join(root, 'resources/research-runtime/process-guard.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
