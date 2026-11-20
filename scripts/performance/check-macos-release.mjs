#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync
} from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { projectRoot } from '../lib/project-paths.mjs';

assert.equal(process.platform, 'darwin', 'Release acceptance requires macOS.');
assert.equal(process.arch, 'arm64', 'Release acceptance requires arm64.');
assert.ok(process.argv.length <= 3, 'Usage: check-macos-release.mjs [report.json]');
const outputPath = resolve(process.argv[2] ?? '.artifacts/mac-performance/release-gates.json');
mkdirSync(dirname(outputPath), { recursive: true });
const runRoot = mkdtempSync(join(dirname(outputPath), 'release-run-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => hash(readFileSync(path));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
assert.equal(revision.status, 0, revision.stderr);
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8' });
assert.equal(tracked.status, 0, tracked.stderr);
const sourceFiles = new Set(tracked.stdout.split('\0').filter(path =>
  /^(src|scripts|tests)\//u.test(path) || /^(package\.json|pnpm-lock\.yaml|tsconfig.*\.json|electron.*\.(ts|yml))$/u.test(path)));
sourceFiles.add('scripts/performance/check-macos-release.mjs');
sourceFiles.add('scripts/performance/drill-macos-rollback.mjs');
const sourceDigest = createHash('sha256');
for (const path of [...sourceFiles].sort()) sourceDigest.update(path).update('\0').update(fileHash(join(projectRoot, path))).update('\0');

const gates = [
  ['install', ['install', '--frozen-lockfile']],
  ['typecheck', ['typecheck']],
  ['build', ['build']],
  ['unit', ['test:unit']],
  ['renderer', ['test:renderer']],
  ['ipc', ['check:ipc']],
  ['renderer-chunks', ['check:renderer-chunks']],
  ['performance-smoke', ['smoke:performance']],
  ['retrieval', ['research:retrieval-bench', join(runRoot, 'retrieval.json')]],
  ['storage', ['research:storage-bench', join(runRoot, 'storage.json')]],
  ['admission', ['research:admission-bench', join(runRoot, 'admission.json')]],
  ['graph', ['research:graph-bench', join(runRoot, 'graph.json')]],
  ['process-resources', ['test:research-resources']],
  ['environment-boundaries', ['test:research-environment-boundaries']],
  ['package', ['package:dir']],
  ['native-packaging', ['verify:native-packaging']],
  ['arm64', ['verify:arm64-only', '--', '--strict']],
  ['electron-smoke', ['smoke:electron']],
  ['packaged-smoke', ['smoke:mac']],
  ['packaged-diagnostic', [process.execPath, 'scripts/smoke-mac.mjs', 'release/mac-arm64/Roc.app', '--diagnostic-rollback']],
  ['rollback', [process.execPath, 'scripts/performance/drill-macos-rollback.mjs', join(runRoot, 'rollback.json')]]
].map(([id, args]) => id === 'packaged-diagnostic' || id === 'rollback'
  ? { id, command: args[0], args: args.slice(1) }
  : { id, command: 'pnpm', args });
const artifacts = {
  retrieval: [join(runRoot, 'retrieval.json')],
  storage: [join(runRoot, 'storage.json')],
  admission: [join(runRoot, 'admission.json')],
  graph: [join(runRoot, 'graph.json')],
  arm64: ['.artifacts/arm64-only/report.json', '.artifacts/arm64-only/macho-inventory.json'],
  'electron-smoke': ['.artifacts/smoke-electron/result.json'],
  'packaged-smoke': ['.artifacts/mac-package/result.json', '.artifacts/mac-package/plugin-app.jsonl'],
  'packaged-diagnostic': ['.artifacts/mac-package-diagnostic/result.json', '.artifacts/mac-package-diagnostic/plugin-app.jsonl'],
  rollback: [join(runRoot, 'rollback.json')]
};
const report = {
  schemaVersion: 1, passed: false, startedAt: new Date().toISOString(), cwd: projectRoot, runRoot,
  source: { gitSha: revision.stdout.trim(), lockSha256: fileHash(join(projectRoot, 'pnpm-lock.yaml')),
    sourceSha256: sourceDigest.digest('hex'), files: sourceFiles.size },
  host: { platform: process.platform, arch: process.arch, node: process.version, osRelease: release(),
    cpu: cpus()[0]?.model, memoryBytes: totalmem() },
  requiredGates: gates.map(gate => gate.id), gates: [], retrievalTargetChallenges: [],
  regressionPercent: 5,
  limitations: [
    'Commands, GUI checks and performance workloads run serially; only generated fixtures are used.',
    'Retrieval target challenges are recorded separately from command success; they are not a before/after regression test.',
    'A P95 regression above 5 percent requires compatible repeated measurements and noise review before release.',
    'This command verifies a local package; it neither publishes nor deploys it.'
  ]
};
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('ROC_PERF_')) delete env[key];
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ROC_DATA_ROOT', 'ROC_SMOKE_TARGET', 'ROC_PERFORMANCE_PROFILE_ROOTS']) delete env[key];

function save() {
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(runRoot, 'result.json'), bytes);
  writeFileSync(outputPath, bytes);
}

function execute(gate, logPath) {
  return new Promise(resolvePromise => {
    const fd = openSync(logPath, 'wx');
    const child = spawn(gate.command, gate.args, { cwd: projectRoot, env, shell: false, stdio: ['ignore', fd, fd] });
    let spawnError = null;
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (exitCode, signal) => {
      closeSync(fd);
      resolvePromise({ exitCode, signal, spawnError });
    });
  });
}

try {
  save();
  for (const [index, gate] of gates.entries()) {
    const label = `${String(index + 1).padStart(2, '0')}-${gate.id}`;
    const logPath = join(runRoot, `${label}.log`);
    const files = (artifacts[gate.id] ?? []).map(path => resolve(projectRoot, path));
    const previousTimes = files.map(path => existsSync(path) ? statSync(path, { bigint: true }).mtimeNs : null);
    const entry = { ...gate, cwd: projectRoot, startedAt: new Date().toISOString(), passed: false, logPath };
    report.gates.push(entry);
    save();
    console.log(`[${index + 1}/${gates.length}] ${gate.command} ${gate.args.join(' ')}`);
    const start = performance.now();
    Object.assign(entry, await execute(gate, logPath), { durationMs: performance.now() - start, finishedAt: new Date().toISOString() });
    entry.logSha256 = fileHash(logPath);
    assert.equal(entry.exitCode, 0, `${gate.id} failed (${entry.spawnError ?? entry.signal ?? entry.exitCode}); see ${logPath}`);
    entry.artifacts = files.map((path, artifactIndex) => {
      assert.ok(existsSync(path), `${gate.id}: missing artifact ${path}`);
      assert.notEqual(statSync(path, { bigint: true }).mtimeNs, previousTimes[artifactIndex], `${gate.id}: stale artifact ${path}`);
      const retainedPath = path.startsWith(`${runRoot}/`) ? path : join(runRoot, `${label}-${basename(path)}`);
      if (path !== retainedPath) copyFileSync(path, retainedPath);
      return { path: retainedPath, sha256: fileHash(retainedPath), bytes: statSync(retainedPath).size };
    });
    if (gate.id === 'install') assert.equal(fileHash(join(projectRoot, 'pnpm-lock.yaml')), report.source.lockSha256);
    if (gate.id === 'retrieval') {
      const retrieval = JSON.parse(readFileSync(files[0], 'utf8'));
      assert.equal(retrieval.scales.length, retrieval.recipe.scales.length);
      for (const scale of retrieval.scales) {
        for (const row of scale.rows) {
          for (const metric of row.targetExceeded) report.retrievalTargetChallenges.push({
            chunks: scale.chunkCount, projectId: row.projectId, query: row.query, cache: row.cache,
            metric, p95Ms: row.summary[metric].p95, targetMs: retrieval.recipe.p95TargetsMs[metric]
          });
        }
      }
    }
    if (gate.id === 'rollback') assert.equal(JSON.parse(readFileSync(files[0], 'utf8')).passed, true);
    entry.passed = true;
    save();
    console.log(`  passed in ${(entry.durationMs / 1000).toFixed(1)}s`);
  }
  report.passed = report.gates.length === gates.length && report.gates.every(gate => gate.passed);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  save();
}
console.log(JSON.stringify({ passed: report.passed, gatesPassed: report.gates.filter(gate => gate.passed).length,
  gatesRequired: gates.length, retrievalTargetChallenges: report.retrievalTargetChallenges.length, outputPath }));
