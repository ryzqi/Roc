import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { ROOT, contained, directory, fail, fileInventory, hash, readJson, sha256, writeJson } from './common.mjs';

const collections = ['evaluation/runs', 'evaluation/comparisons', 'evaluation/local/incidents', 'evaluation/local/experiments'];
const generatedDataset = /^(?:qasper|rag-retrieval|rag-paper-qa|scienceagentbench|roc-capability|roc-e2e-research|roc-security)-[a-f0-9]{64}$/u;
const legacy = ['.artifacts/evaluation-model-identity-2026-11-13', 'docs/agent-harness-evaluation-audit-2026-11-08.md'];
function resolvedLocation(path) {
  let parent = resolve(path);
  const suffix = [];
  while (!existsSync(parent)) {
    suffix.unshift(basename(parent));
    parent = dirname(parent);
  }
  return join(realpathSync(parent), ...suffix);
}
function allowed(path, options) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || posix.normalize(path) !== path
    || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return collections.some(root => dirname(path) === root)
    || options.includeDatasets && path.startsWith('evaluation/datasets/') && generatedDataset.test(path.slice('evaluation/datasets/'.length))
    || options.includeLegacy && legacy.includes(path);
}
function inventory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail('policy', 'cleanup_symlink');
  return stat.isDirectory() ? fileInventory(path) : stat.isFile()
    ? [{ path: '.', bytes: stat.size, sha256: sha256(readFileSync(path)) }] : fail('policy', 'cleanup_special_file');
}
function activeOwner(path) {
  const ownerPath = join(path, 'execution-owner.json');
  if (!existsSync(ownerPath)) return false;
  const owner = readJson(ownerPath);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail('state', 'cleanup_owner_invalid');
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function references(root, paths) {
  const refs = new Set();
  function visit(value) {
    if (typeof value === 'string' && (isAbsolute(value) || value.startsWith('evaluation/'))) {
      const path = resolve(root, value);
      refs.add(existsSync(path) ? realpathSync(path) : path);
    }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  for (const path of paths) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    for (const name of ['manifest.json', 'protocol.json', 'comparison.json', 'report.json',
      'incident.json', 'assessment.json', 'decision.json', 'candidate.json', 'baseline.json']) {
      const file = join(path, name);
      if (existsSync(file)) visit(readJson(file));
    }
  }
  return refs;
}
export function planEvaluationCleanup({ root = ROOT, includeDatasets = false, includeLegacy = false } = {}) {
  root = realpathSync(root);
  const options = { includeDatasets, includeLegacy }, candidates = [], targets = [], preserved = [];
  for (const collection of [...collections, ...(includeDatasets ? ['evaluation/datasets'] : [])]) {
    const parent = contained(root, collection);
    if (!existsSync(parent)) continue;
    if (realpathSync(parent) !== parent) fail('policy', 'cleanup_collection_symlink');
    for (const name of readdirSync(parent).sort()) {
      const path = `${collection}/${name}`;
      if (allowed(path, options)) candidates.push(path);
    }
  }
  if (includeLegacy) candidates.push(...legacy.filter(path => existsSync(contained(root, path))));
  for (const path of candidates) {
    const target = contained(root, path);
    try {
      if (activeOwner(target)) { preserved.push({ path, reason: 'active_owner' }); continue; }
      const files = inventory(target), stat = lstatSync(target);
      targets.push({ path, files, inventoryHash: hash(files), device: String(stat.dev), inode: String(stat.ino),
        bytes: files.reduce((sum, file) => sum + file.bytes, 0) });
    } catch (error) { preserved.push({ path, reason: error.message }); }
  }
  // References are transitive: an active experiment can retain a run, whose
  // manifest in turn retains a prepared dataset.
  let changed;
  do {
    changed = false;
    const retainedReferences = references(root, preserved.map(item => contained(root, item.path)));
    for (let index = targets.length - 1; index >= 0; index--) {
      const target = contained(root, targets[index].path);
      if ([...retainedReferences].some(ref => ref === target || ref.startsWith(`${target}${sep}`))) {
        preserved.push({ path: targets[index].path, reason: 'referenced_by_retained_record' }); targets.splice(index, 1);
        changed = true;
      }
    }
  } while (changed);
  const plan = { schemaVersion: 1, root, createdAt: new Date().toISOString(), options, targets, preserved,
    bytes: targets.reduce((sum, target) => sum + target.bytes, 0) };
  return { ...plan, planHash: hash(plan), status: 'preview' };
}
export function applyEvaluationCleanup(preview, { outputRoot } = {}) {
  const { planHash, status, ...plan } = preview;
  if (status !== 'preview' || plan.schemaVersion !== 1 || hash(plan) !== planHash
    || !Array.isArray(plan.targets) || !Array.isArray(plan.preserved) || !plan.options
    || typeof plan.options.includeDatasets !== 'boolean' || typeof plan.options.includeLegacy !== 'boolean'
    || realpathSync(plan.root) !== plan.root) fail('state', 'cleanup_plan_invalid');
  if (new Set(plan.targets.map(target => target.path)).size !== plan.targets.length) fail('policy', 'cleanup_duplicate_target');
  if (plan.targets.some(target => !allowed(target.path, plan.options))) fail('policy', 'cleanup_target_out_of_scope');
  const recordParent = resolvedLocation(outputRoot ?? join(plan.root, 'evaluation/local/cleanup'));
  if (plan.targets.some(target => {
    const targetPath = contained(plan.root, target.path);
    return recordParent === targetPath || recordParent.startsWith(`${targetPath}${sep}`);
  })) fail('policy', 'cleanup_record_inside_target');
  // Verify every resolved target before the first removal.
  for (const target of plan.targets) {
    if (!allowed(target.path, plan.options)) fail('policy', 'cleanup_target_out_of_scope');
    const path = contained(plan.root, target.path), stat = lstatSync(path);
    if (realpathSync(path) !== path || String(stat.dev) !== target.device || String(stat.ino) !== target.inode || hash(inventory(path)) !== target.inventoryHash
      || activeOwner(path)) fail('state', 'cleanup_target_changed_or_active');
  }
  const deleting = new Set(plan.targets.map(target => target.path)), retained = [];
  for (const collection of collections) {
    const parent = contained(plan.root, collection);
    if (!existsSync(parent)) continue;
    if (realpathSync(parent) !== parent) fail('policy', 'cleanup_collection_symlink');
    for (const name of readdirSync(parent)) {
      const path = `${collection}/${name}`;
      if (!deleting.has(path)) retained.push(contained(plan.root, path));
    }
  }
  const retainedReferences = references(plan.root, retained);
  if (plan.targets.some(target => {
    const path = contained(plan.root, target.path);
    return [...retainedReferences].some(ref => ref === path || ref.startsWith(`${path}${sep}`));
  })) fail('state', 'cleanup_target_newly_referenced');
  const record = directory(recordParent, 'cleanup');
  writeJson(join(record, 'plan.json'), preview);
  const archives = [];
  for (const target of plan.targets.filter(target => target.path.startsWith('evaluation/datasets/'))) {
    const source = contained(plan.root, target.path), manifest = readJson(join(source, 'dataset.json'));
    const raw = target.files.find(file => file.path === 'source.tgz');
    if (!raw) continue;
    if (!/^[a-z][a-z0-9-]*$/u.test(manifest.suite)
      || target.path !== `evaluation/datasets/${manifest.suite}-${target.path.slice(-64)}`) fail('data', 'cleanup_original_archive_suite_mismatch');
    if (manifest.provenance?.archiveSha256 !== raw.sha256) fail('data', 'cleanup_original_archive_hash_mismatch');
    const archive = join(plan.root, 'evaluation/local/sources', manifest.suite, `${raw.sha256}.tgz`);
    if (resolvedLocation(archive) !== archive) fail('policy', 'cleanup_source_archive_symlink');
    mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
    if (!existsSync(archive)) copyFileSync(join(source, raw.path), archive);
    if (!lstatSync(archive).isFile() || lstatSync(archive).isSymbolicLink()
      || sha256(readFileSync(archive)) !== raw.sha256) fail('data', 'cleanup_original_archive_copy_failed');
    archives.push({ path: relative(plan.root, archive), sha256: raw.sha256, license: manifest.provenance.license,
      attribution: manifest.provenance.url, priorDatasetIdentity: manifest.identity });
  }
  writeJson(join(record, 'retained-sources.json'), archives);
  for (const target of plan.targets) rmSync(contained(plan.root, target.path), { recursive: true });
  const result = { schemaVersion: 1, status: 'applied', planHash, completedAt: new Date().toISOString(),
    directory: record, removed: plan.targets.map(({ path, inventoryHash, bytes }) => ({ path, inventoryHash, bytes })),
    preserved: plan.preserved, retainedSources: archives, bytes: plan.bytes };
  writeJson(join(record, 'result.json'), result);
  return result;
}
