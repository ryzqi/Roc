import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE, sha256 } from '../lib/common.mjs';
import { loadDataset } from '../lib/data.mjs';

// Independently retained official bytes, audited locally on 2026-11-14.
// No download, replacement data, mock pins or inferred "official" provenance.
const path = join(CACHE, 'qasper-6be4b447c84046b689e019c551f3e331e962ff2837462d2cd6d6ff099a7df3d0');
export const officialQasper = existsSync(path) ? loadDataset(path) : null;
if (officialQasper) {
  assert.equal(sha256(readFileSync(join(path, 'source.tgz'))), 'a28fdf966db827bcee3d873107d6b6669864fb7ca8fbf73a192f5e39191bdb5a');
  assert.equal(sha256(readFileSync(join(path, 'qasper-dev-v0.3.json'))), '2ae7ee62a65b1c4225791c70de80c2aad4e8998cf1fd4f09a53103db4f21af93');
  assert.equal(sha256(readFileSync(join(path, 'tasks.json'))), '7ad52176538faa74f6752202f8eb4ae1a6eee7798272d4b4ecc8719b7415421b');
  assert.equal(officialQasper.qasperQualification.status, 'verified');
}
export function officialQasperFields(clusters = 5, split = 'development') {
  if (!officialQasper) return null;
  const selected = [], seen = new Set();
  for (const task of officialQasper.tasks) {
    if (task.unsupported || task.split !== split || seen.has(task.clusterId)) continue;
    seen.add(task.clusterId); selected.push({ id: task.id, clusterId: task.clusterId });
    if (selected.length === clusters) break;
  }
  assert.equal(selected.length, clusters);
  return { dataset: { path: officialQasper.root, identity: officialQasper.manifest.identity },
    datasetIdentity: officialQasper.manifest.identity, datasetProvenance: structuredClone(officialQasper.manifest.provenance),
    qasperQualification: structuredClone(officialQasper.qasperQualification), selection: selected };
}
export function officialQasperTest(name, callback) {
  return test(name, { skip: officialQasper ? false : 'independently pinned local official QASPER is unavailable; no network fallback' }, callback);
}
