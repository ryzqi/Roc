import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const [output] = process.argv.slice(2);
if (!output || !resolve(output).startsWith(resolve('.artifacts') + '/')) {
  throw new Error('usage: node evaluation/adapters/s01/prepare-worker.mjs .artifacts/<directory>');
}
const changes = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'evaluation/runtime', 'package.json', 'pnpm-lock.yaml'], { encoding: 'utf8' });
if (changes.trim()) throw new Error('quality_worker_requires_committed_application_sources');
const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
mkdirSync(output, { recursive: true });
const path = resolve(output, 'application-worker.mjs');
const compilation = await build({ entryPoints: ['evaluation/runtime/application-worker.ts'],
  outfile: path, bundle: true, packages: 'external', platform: 'node', format: 'esm', metafile: true,
  loader: { '.md': 'text' }, logLevel: 'silent' });
if (Object.keys(compilation.metafile.inputs).some(name => /fixtures|evaluation\/(?:lib|tests|graders|analysis)\/|evaluation\/adapters\/(?:native|s01)\//u.test(name))) {
  throw new Error('quality_worker_evaluator_code_in_graph');
}
const artifact = { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), commitSha,
  nodeModulesPath: realpathSync('node_modules'), nodeVersion: process.version,
  lockfilePath: realpathSync('pnpm-lock.yaml'),
  lockfileSha256: createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex') };
writeFileSync(join(output, 'worker.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify(artifact));
