import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs, {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {sha256} from '../../evaluation/lib/common.mjs';
import {benchmarkScientificNativeBaseline, buildScientificNativeSnapshot} from '../../scripts/benchmark-scientific-native-baseline.mjs';

test('native baseline rejects wrong source hash before creating output and preserves existing results', async () => {
  mkdirSync(resolve('.runtime'), {recursive: true});
  const root = mkdtempSync(resolve('.runtime/native-baseline-'));
  try {
    const source = join(root, 'paper.pdf'), output = join(root, 'output'), bytes = Buffer.from('%PDF-1.7\nfixture');
    writeFileSync(source, bytes);
    await assert.rejects(benchmarkScientificNativeBaseline({source, output, sourceHash: 'a'.repeat(64)}), /source_changed/);
    assert.equal(existsSync(output), false);
    mkdirSync(output); writeFileSync(join(output, 'retained.json'), 'existing baseline');
    await assert.rejects(benchmarkScientificNativeBaseline({source, output, sourceHash: sha256(bytes)}), /output_exists/);
    assert.equal(readFileSync(join(output, 'retained.json'), 'utf8'), 'existing baseline');
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('native baseline rejects output containing input and linked source paths', async () => {
  mkdirSync(resolve('.runtime'), {recursive: true});
  const root = mkdtempSync(resolve('.runtime/native-baseline-'));
  try {
    const source = join(root, 'paper.pdf'), linked = join(root, 'linked.pdf'), bytes = Buffer.from('%PDF-1.7\nfixture');
    writeFileSync(source, bytes); symlinkSync(source, linked);
    await assert.rejects(benchmarkScientificNativeBaseline({source, output: root, sourceHash: sha256(bytes)}), /path_invalid/);
    await assert.rejects(benchmarkScientificNativeBaseline({source: linked, output: join(root, 'output'),
      sourceHash: sha256(bytes)}), /path_link/);
    assert.deepEqual(readFileSync(source), bytes);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('native parser failure retains an unscored receipt and removes temporary and partial output', async () => {
  mkdirSync(resolve('.runtime'), {recursive: true});
  const root = mkdtempSync(resolve('.runtime/native-baseline-'));
  try {
    const source = join(root, 'invalid.pdf'), output = join(root, 'output'), bytes = Buffer.from('not a PDF');
    writeFileSync(source, bytes);
    const report = await benchmarkScientificNativeBaseline({source, output, sourceHash: sha256(bytes)});
    assert.equal(report.status, 'failed'); assert.ok(report.failure.code);
    assert.equal(report.qualityMetrics, null); assert.equal(report.scientificBaselineReady, false);
    assert.equal(existsSync(join(output, 'parsed')), false);
    assert.equal(existsSync(join(output, 'runtime.mjs')), false);
    assert.equal(existsSync(join(output, 'result.json')), false);
    assert.equal(JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')).status, 'failed');
    assert.deepEqual(readFileSync(source), bytes);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('native baseline rejects oversized sparse PDF before reading or creating output', async () => {
  mkdirSync(resolve('.runtime'), {recursive: true});
  const root = mkdtempSync(resolve('.runtime/native-baseline-'));
  try {
    const source = join(root, 'oversized.pdf'), output = join(root, 'output');
    writeFileSync(source, '%PDF-1.7\n'); truncateSync(source, 512 * 1024 * 1024 + 1);
    await assert.rejects(benchmarkScientificNativeBaseline({source, output, sourceHash: 'a'.repeat(64)}), /research_source_too_large/);
    assert.equal(existsSync(output), false);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('snapshot rejects a source modified after esbuild reads it but before hashes could be collected', async () => {
  mkdirSync(resolve('.runtime'), {recursive: true});
  const root = mkdtempSync(resolve('.runtime/native-baseline-'));
  const originalRead = fs.readFileSync;
  let replacement;
  try {
    const entry = join(root, 'entry.ts');
    writeFileSync(entry, 'export const value = "before";\n');
    let changed = false;
    replacement = mock.method(fs, 'readFileSync', (path, ...args) => {
      const bytes = originalRead(path, ...args);
      if (path === entry && !changed) {
        changed = true; writeFileSync(entry, 'export const value = "after";\n');
      }
      return bytes;
    });
    syncBuiltinESMExports();
    await assert.rejects(buildScientificNativeSnapshot({root, entryPoints: ['entry.ts'], external: [], auxiliaryPaths: []}),
      /scientific_native_code_changed/);
    assert.equal(changed, true);
  } finally {
    replacement?.mock.restore(); syncBuiltinESMExports();
    rmSync(root, {recursive: true, force: true});
  }
});
