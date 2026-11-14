import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { CACHE, contained, directory, fail, fileInventory, hash, readJson, sha256, writeJson } from './common.mjs';
import { loadPython } from './local-python.mjs';
import { importQasper } from './qasper.mjs';

const sourceLockUrl = new URL('./sources.lock.json', import.meta.url);
const qasperQualifications = new Map();
export function qasperSourceContract() {
  const lockBytes = readFileSync(sourceLockUrl);
  const descriptor = { schemaVersion: 1, source: JSON.parse(lockBytes).qasper, sourceLockSha256: sha256(lockBytes),
    adaptation: 'roc-adapted-text-v1', split: 'paper-hash-80-20-v1',
    derivation: { serialization: 'json-two-space-newline-v1',
      files: ['data.mjs', 'qasper.mjs', 'common.mjs'].map(path => ({
        path: `lib/${path}`, sha256: sha256(readFileSync(new URL(path, import.meta.url)))
      })) } };
  return { ...descriptor, hash: hash(descriptor) };
}
function qualifyQasperDataset(root, manifest, inventory) {
  const sourceContract = qasperSourceContract(), source = sourceContract.source;
  const payload = { schemaVersion: 1, kind: 'locked-official-qasper-adaptation', sourceContract,
    datasetIdentity: manifest.identity, inventoryHash: hash(inventory),
    tasksSha256: inventory.find(file => file.path === 'tasks.json')?.sha256 ?? null };
  const unverified = reason => {
    const value = { ...payload, status: 'unverified', reason };
    return { ...value, hash: hash(value) };
  };
  const provenance = { ...source, adaptation: sourceContract.adaptation, split: sourceContract.split };
  if (hash(manifest.provenance) !== hash(provenance)) return unverified('qasper_source_provenance_not_locked');
  const paths = ['source.tgz', source.member, 'tasks.json'];
  if (inventory.length !== paths.length || inventory.some(file => !paths.includes(file.path))) {
    return unverified('qasper_source_inventory_invalid');
  }
  const archive = inventory.find(file => file.path === 'source.tgz'), member = inventory.find(file => file.path === source.member);
  if (archive.sha256 !== source.archiveSha256 || member.sha256 !== source.memberSha256) {
    return unverified('qasper_locked_source_bytes_missing_or_changed');
  }
  // This cache is keyed by freshly hashed on-disk inventory, the complete
  // manifest and current derivation code. Caller-supplied status/pins never enter it.
  const key = hash({ sourceContract, manifest, inventory });
  if (qasperQualifications.has(key)) return structuredClone(qasperQualifications.get(key));
  try {
    const bytes = execFileSync('/usr/bin/tar', ['-xOzf', join(root, 'source.tgz'), source.member],
      { maxBuffer: 16 * 1024 * 1024 });
    if (sha256(bytes) !== source.memberSha256 || member.bytes !== bytes.length) {
      return unverified('qasper_archive_member_not_locked');
    }
    const tasks = importQasper(JSON.parse(bytes)), tasksBytes = Buffer.from(JSON.stringify(tasks, null, 2) + '\n');
    const expectedInventory = inventory.map(file => file.path === 'tasks.json'
      ? { path: file.path, bytes: tasksBytes.length, sha256: sha256(tasksBytes) } : file);
    if (hash(expectedInventory) !== hash(inventory)) return unverified('qasper_adapted_tasks_not_derived_from_locked_member');
    const identity = hash({ suite: 'qasper', provenance, inventory: expectedInventory });
    if (identity !== manifest.identity || manifest.total !== tasks.length
      || manifest.supported !== tasks.filter(task => !task.unsupported).length) {
      return unverified('qasper_derived_dataset_identity_invalid');
    }
    const value = { ...payload, status: 'verified', derivedDatasetIdentity: identity, adaptedTasksHash: hash(tasks), taskCount: tasks.length,
      supportedTaskCount: manifest.supported };
    const qualification = { ...value, hash: hash(value) };
    qasperQualifications.set(key, qualification);
    return structuredClone(qualification);
  } catch {
    return unverified('qasper_locked_source_derivation_failed');
  }
}
const relativePath = z.string().min(1).refine(s => !s.startsWith('/') && !s.split('/').some(p => ['..', '.', ''].includes(p)) && !/[\\,\n\r]/u.test(s));
const outputPath = relativePath.refine(s => !/\.(?:py|pyc|pyo|pyw|js|mjs|cjs|ts|sh|bash|zsh|so|dylib|dll|exe|pth)$/i.test(s), 'output_must_be_data');
export const scienceRecipeSchema = z.strictObject({
  schemaVersion: z.literal(2), split: z.literal('verified'),
  sourceRevision: z.string().min(1), metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tasks: z.array(z.strictObject({
    id: z.string().regex(/^\d+$/), publicDir: z.string().min(1), hiddenDir: z.string().min(1),
    pythonEnvironment: z.string().min(1), verifierEnvironment: z.string().min(1), verifierDir: z.string().min(1), calibrationDir: z.string().min(1), outputFiles: z.array(outputPath).min(1),
    license: z.string().min(1)
  })).min(1)
});
export function sealDataset(dir, suite, provenance, tasks, cacheRoot = CACHE) {
  writeJson(join(dir, 'tasks.json'), tasks);
  const inventory = fileInventory(dir);
  const identity = hash({ suite, provenance, inventory });
  writeJson(join(dir, 'dataset.json'), { schemaVersion: 1, suite, identity, provenance, inventory,
    total: tasks.length, supported: tasks.filter(t => !t.unsupported).length });
  const target = join(cacheRoot, `${suite}-${identity}`);
  if (existsSync(target)) { loadDataset(target); rmSync(dir, { recursive: true }); }
  else renameSync(dir, target);
  return target;
}
export function loadDataset(path) {
  const root = resolve(path), manifest = readJson(join(root, 'dataset.json'));
  const actual = fileInventory(root).filter(f => f.path !== 'dataset.json');
  if (hash(actual) !== hash(manifest.inventory) || hash({ suite: manifest.suite, provenance: manifest.provenance, inventory: actual }) !== manifest.identity) fail('data', 'dataset_integrity_failed');
  return { root, manifest, tasks: readJson(join(root, 'tasks.json')),
    ...(manifest.suite === 'qasper' ? { qasperQualification: qualifyQasperDataset(root, manifest, actual) } : {}) };
}
export function hasQasperQualityProvenance(manifest) {
  // Old manifests remain engineering evidence. Qualification is frozen by a
  // fresh run; comparison must not retroactively add it to historical records.
  if (manifest?.suite !== 'qasper' || manifest.qasperQualification?.status !== 'verified'
    || typeof manifest.dataset?.path !== 'string' || manifest.dataset.identity !== manifest.datasetIdentity) return false;
  try {
    const dataset = loadDataset(manifest.dataset.path);
    if (dataset.manifest.suite !== 'qasper' || dataset.manifest.identity !== manifest.datasetIdentity
      || dataset.qasperQualification.status !== 'verified'
      || hash(manifest.datasetProvenance) !== hash(dataset.manifest.provenance)
      || hash(manifest.qasperQualification) !== hash(dataset.qasperQualification)) return false;
    const tasks = new Map(dataset.tasks.map(task => [task.id, task]));
    return Array.isArray(manifest.selection) && manifest.selection.length > 0 && manifest.selection.every(selected => {
      const task = tasks.get(selected.id);
      return task && !task.unsupported && task.clusterId === selected.clusterId && task.split === manifest.split;
    });
  } catch {
    return false;
  }
}
export async function prepareQasper(archivePath) {
  const dir = directory(CACHE, 'preparing-qasper');
  try {
    const source = qasperSourceContract().source;
    let archive;
    if (archivePath) archive = readFileSync(archivePath);
    else {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
      if (!response.ok) fail('data', `qasper_download_${response.status}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 16 * 1024 * 1024) fail('data', 'qasper_archive_too_large'); chunks.push(chunk); }
      archive = Buffer.concat(chunks);
    }
    if (sha256(archive) !== source.archiveSha256) fail('data', 'qasper_archive_hash_mismatch');
    const archiveFile = join(dir, 'source.tgz'); writeFileSync(archiveFile, archive, { mode: 0o600 });
    // Fixed member, verified archive, stdout extraction: no archive paths are written to disk.
    const bytes = execFileSync('/usr/bin/tar', ['-xOzf', archiveFile, source.member], { maxBuffer: 16 * 1024 * 1024 });
    if (sha256(bytes) !== source.memberSha256) fail('data', 'qasper_member_hash_mismatch');
    writeFileSync(join(dir, source.member), bytes, { mode: 0o600 });
    return sealDataset(dir, 'qasper', { ...source, adaptation: 'roc-adapted-text-v1', split: 'paper-hash-80-20-v1' }, importQasper(JSON.parse(bytes)));
  } catch (error) { writeJson(join(dir, 'prepare-error.json'), { error: error.message }); throw error; }
}
export function prepareScience(metadataPath, recipePath, bundlePath, { cacheRoot = CACHE } = {}) {
  const metadataBytes = readFileSync(metadataPath), recipe = scienceRecipeSchema.parse(readJson(recipePath));
  if (sha256(metadataBytes) !== recipe.metadataSha256 || sha256(readFileSync(bundlePath)) !== recipe.bundleSha256) fail('data', 'science_source_hash_mismatch');
  const metadata = JSON.parse(metadataBytes);
  if (!Array.isArray(metadata) || new Set(metadata.map(r => String(r.instance_id))).size !== metadata.length) fail('data', 'science_metadata_invalid');
  const dir = directory(cacheRoot, 'preparing-science'), ids = new Set();
  const tasks = recipe.tasks.map(item => {
    if (ids.has(item.id)) fail('data', 'science_duplicate_task'); ids.add(item.id);
    const row = metadata.find(r => String(r.instance_id) === item.id);
    if (!row || typeof row.task_inst !== 'string' || typeof row.output_fname !== 'string') fail('data', 'science_metadata_task_missing');
    const pythonEnvironment = loadPython(resolve(dirname(recipePath), item.pythonEnvironment));
    const verifierEnvironment = loadPython(resolve(dirname(recipePath), item.verifierEnvironment));
    const destinations = {};
    for (const key of ['publicDir', 'hiddenDir', 'verifierDir', 'calibrationDir']) {
      const source = resolve(dirname(recipePath), item[key]);
      fileInventory(source); // Reject links before copying local prepared data.
      const relative = `assets/${item.id}/${key}`, target = contained(dir, relative);
      mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true }); destinations[key] = relative;
    }
    return { id: item.id, clusterId: row.github_name || item.id, split: parseInt(hash(row.github_name || item.id).slice(0, 8), 16) % 5 === 0 ? 'holdout' : 'development', unsupported: null,
      visible: { prompt: row.task_inst, domainKnowledge: row.domain_knowledge ?? '', declaredOutput: row.output_fname },
      environment: { ...item, ...destinations,
        pythonEnvironment: join(pythonEnvironment.root, 'environment.json'), pythonIdentity: pythonEnvironment.lock.identity,
        verifierEnvironment: join(verifierEnvironment.root, 'environment.json'), verifierIdentity: verifierEnvironment.lock.identity } };
  });
  writeJson(join(dir, 'metadata.json'), metadata);
  writeJson(join(dir, 'recipe.json'), recipe);
  // Supplied hashes establish local integrity, not an independently verified
  // upstream source or the correspondence of prepared assets to that bundle.
  return sealDataset(dir, 'scienceagentbench', { kind: 'engineering_fixture', split: 'verified', sourceRevision: recipe.sourceRevision,
    metadataSha256: recipe.metadataSha256, bundleSha256: recipe.bundleSha256, adaptation: 'roc-local-output-verifier-v2',
    metadataTasks: metadata.length, selectedTasks: tasks.length, omittedIds: metadata.filter(r => !ids.has(String(r.instance_id))).map(r => String(r.instance_id)) }, tasks, cacheRoot);
}
