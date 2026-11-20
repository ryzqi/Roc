import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireCapabilitySources, downloadLockedArtifact } from '../capability/acquire.mjs';
import { prepareQasper, loadDataset } from '../../lib/data.mjs';
import { EVAL_ROOT, hash, readJson, sha256, writeJson } from '../../lib/common.mjs';

export const publicScientificSourceLock = new URL('../../corpora/scientific-rag/public-sources.lock.json', import.meta.url);
export const defaultPublicScientificRoot = join(EVAL_ROOT, 'local/sources/scientific-public');

function localPath(root, name, create = false) {
  if (typeof name !== 'string' || name.startsWith('/') || /[\\\r\n]/u.test(name)
    || name.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('scientific_public_path_invalid');
  let path = realpathSync(root);
  for (const [index, part] of name.split('/').entries()) {
    path = join(path, part);
    const last = index === name.split('/').length - 1;
    if (!last && !existsSync(path) && create) mkdirSync(path, { mode: 0o700 });
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !(last ? stat.isFile() : stat.isDirectory())) throw new Error('scientific_public_path_invalid');
      const rel = relative(realpathSync(root), realpathSync(path));
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('scientific_public_path_invalid');
    }
  }
  return path;
}

export function verifyPublicScientificSources(root = defaultPublicScientificRoot) {
  const lock = readJson(publicScientificSourceLock);
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error('scientific_public_snapshot_missing');
  }
  const files = lock.files.map(pin => {
    const path = localPath(root, pin.path);
    if (!existsSync(path) || lstatSync(path).size !== pin.bytes
      || sha256(readFileSync(path)) !== pin.sha256) throw new Error(`scientific_public_source_changed:${pin.path}`);
    return { path: pin.path, bytes: pin.bytes, sha256: pin.sha256 };
  });
  return { schemaVersion: 1, root: resolve(root), sourceLockHash: hash(lock), files,
    pdfCount: files.filter(file => file.path.endsWith('.pdf')).length,
    imageCount: files.filter(file => file.path.startsWith('omnidocbench/images/')).length,
    annotationProvenance: lock.annotationProvenance, scientificBaselineReady: false };
}

/** Reuse the official QASPER seal and bounded locked-byte acquisition. Never
 * overwrite snapshots or turn published labels into fictitious local reviews. */
export async function acquirePublicScientificSources({ root = defaultPublicScientificRoot, offline = false } = {}) {
  const lock = readJson(publicScientificSourceLock);
  if (lock.schemaVersion !== 1 || !lock.files.length || new Set(lock.files.map(file => file.path)).size !== lock.files.length
    || lock.files.reduce((sum, file) => sum + file.bytes, 0) > 256 * 1024 * 1024) throw new Error('scientific_public_lock_invalid');
  const original = await acquireCapabilitySources({ sourceIds: ['qasper'], offline });
  const datasetRoot = await prepareQasper(join(original.sources[0].root, 'source.tgz'));
  const dataset = loadDataset(datasetRoot);
  if (dataset.qasperQualification.status !== 'verified') throw new Error('scientific_public_qasper_unqualified');
  if (!existsSync(root) && !offline) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error('scientific_public_snapshot_missing');
  }
  for (const pin of lock.files) {
    const path = localPath(root, pin.path, !offline);
    if (existsSync(path)) {
      if (lstatSync(path).size !== pin.bytes || sha256(readFileSync(path)) !== pin.sha256) {
        throw new Error(`scientific_public_source_changed:${pin.path}`);
      }
      continue;
    }
    if (offline) throw new Error(`scientific_public_source_missing:${pin.path}`);
    const bytes = await downloadLockedArtifact(pin);
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  }
  return { ...verifyPublicScientificSources(root), qasper: { root: datasetRoot,
    qualification: dataset.qasperQualification, papers: new Set(dataset.tasks.map(task => task.clusterId)).size,
    questions: dataset.tasks.length, supportedQuestions: dataset.manifest.supported } };
}

async function main(args) {
  let root = defaultPublicScientificRoot, offline = false, output = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = args[++i];
    else if (args[i] === '--offline') offline = true;
    else if (args[i] === '--output') output = args[++i];
    else throw new Error('scientific_public_argument_unknown');
  }
  if (!root || (output !== null && !output)) throw new Error('scientific_public_argument_missing');
  const receipt = await acquirePublicScientificSources({ root: resolve(root), offline });
  if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeJson(resolve(output), receipt); }
  console.log(JSON.stringify({ sourceLockHash: receipt.sourceLockHash, pdfs: receipt.pdfCount,
    images: receipt.imageCount, qasper: { root: receipt.qasper.root,
      papers: receipt.qasper.papers, questions: receipt.qasper.questions, supported: receipt.qasper.supportedQuestions },
    scientificBaselineReady: false }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
