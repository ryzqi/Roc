import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const worker = fileURLToPath(new URL('../../../resources/research-runtime/worker.py', import.meta.url));
const python = process.env.ROC_RESEARCH_TOOLCHAIN === undefined
  ? '/Users/Apple_501/Desktop/Roc/Roc/.runtime/research-toolchain/darwin-arm64/python/bin/python3'
  : join(process.env.ROC_RESEARCH_TOOLCHAIN, 'python/bin/python3');

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-worker-')));
  roots.push(root);
  return root;
}

function runWorkerPython(code: string, args: string[], extra?: { input?: string; cwd?: string }): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(python, ['-I', '-B', '-c', code, ...args], {
    encoding: 'utf8',
    input: extra?.input,
    cwd: extra?.cwd,
    timeout: 30_000
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe.skipIf(!existsSync(python))('research worker runtime', () => {
  it('does not overwrite existing output', async () => {
    const root = await workspace();
    await mkdir(join(root, 'parsed'));
    await writeFile(join(root, 'parsed/keep.txt'), 'keep');
    await writeFile(join(root, 'paper.pdf'), 'invalid pdf');
    await mkdir(join(root, 'models'));
    const result = runWorkerPython(`
import json, runpy, sys
from pathlib import Path
worker = runpy.run_path(sys.argv[1])
request = json.loads(sys.argv[2])
try:
    worker['parse_request'](request)
    raise SystemExit('expected failure')
except ValueError as error:
    if 'research_output_already_exists' not in str(error):
        raise
print(Path(request['outputDir'], 'keep.txt').read_text())
`, [worker, JSON.stringify({
      operation: 'parse_document', projectRoot: root, sourcePath: join(root, 'paper.pdf'),
      outputDir: join(root, 'parsed'), modelsPath: join(root, 'models')
    })]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('keep');
  });

  it('rejects path traversal and a symlinked parent', async () => {
    const root = await workspace();
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'roc-worker-outside-')));
    roots.push(outside);
    await writeFile(join(outside, 'paper.pdf'), 'outside');
    await symlink(outside, join(root, 'linked'));
    await writeFile(join(root, 'paper.pdf'), 'invalid pdf');
    await mkdir(join(root, 'models'));
    const result = runWorkerPython(`
import json, os, runpy, sys
from pathlib import Path
worker = runpy.run_path(sys.argv[1])
base = json.loads(sys.argv[2])
for source in [sys.argv[3], sys.argv[4]]:
    try:
        worker['parse_request']({**base, 'sourcePath': source})
        raise SystemExit(f'expected research_path_outside_project for {source}')
    except ValueError as error:
        if 'research_path_outside_project' not in str(error):
            raise
try:
    worker['parse_request']({**base, 'outputDir': sys.argv[5]})
    raise SystemExit('expected research_path_outside_project for output')
except ValueError as error:
    if 'research_path_outside_project' not in str(error):
        raise
print('ok' if not Path(sys.argv[5]).exists() else 'leaked')
`, [worker, JSON.stringify({
      operation: 'parse_document', projectRoot: root, sourcePath: join(root, 'paper.pdf'),
      outputDir: join(root, 'parsed'), modelsPath: join(root, 'models')
    }), join(outside, 'paper.pdf'), join(root, 'linked/paper.pdf'), join(outside, 'new-output')]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  it('rejects unknown operations before creating output', async () => {
    const root = await workspace();
    await writeFile(join(root, 'paper.pdf'), 'invalid pdf');
    await mkdir(join(root, 'models'));
    const result = runWorkerPython(`
import json, runpy, sys
from pathlib import Path
worker = runpy.run_path(sys.argv[1])
request = json.loads(sys.argv[2])
try:
    worker['parse_request']({**request, 'extra': 1})
    raise SystemExit('expected research_request_fields_invalid')
except ValueError as error:
    if 'research_request_fields_invalid' not in str(error):
        raise
try:
    worker['parse_request']({key: value for key, value in request.items() if key != 'modelsPath'} | {'operation': 'render_pdf', 'page': 1, 'scale': 1})
    raise SystemExit('expected operation_unknown')
except ValueError as error:
    if 'operation_unknown' not in str(error):
        raise
print('missing' if not Path(request['outputDir']).exists() else 'created')
`, [worker, JSON.stringify({
      operation: 'parse_document', projectRoot: root, sourcePath: join(root, 'paper.pdf'),
      outputDir: join(root, 'parsed'), modelsPath: join(root, 'models')
    })]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('missing');
  });

  it('returns a JSON error without traceback on stdout', () => {
    const result = spawnSync(python, ['-I', '-B', worker], {
      encoding: 'utf8',
      input: JSON.stringify({ operation: 'unknown' }),
      timeout: 30_000
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: { code: 'research_operation_unknown', type: 'ValueError' } });
  });
});
