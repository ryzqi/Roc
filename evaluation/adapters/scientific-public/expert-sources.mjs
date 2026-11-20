import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {downloadLockedArtifact} from '../capability/acquire.mjs';
import {capabilityRelativePath} from '../capability/sources.mjs';
import {EVAL_ROOT, hash, readJson, sha256, writeJson} from '../../lib/common.mjs';

export const expertPublicSourceLock = new URL('../../corpora/scientific-rag/expert-sources.lock.json', import.meta.url);
export const defaultExpertPublicRoot = join(EVAL_ROOT, 'local/sources/scientific-expert');

function sourcePath(root, name, create = false) {
  capabilityRelativePath(name);
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error('scientific_expert_snapshot_missing');
  }
  let path = realpathSync(root);
  const parts = name.split('/');
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    if (i < parts.length - 1 && !existsSync(path) && create) mkdirSync(path, {mode: 0o700});
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !(i === parts.length - 1 ? stat.isFile() : stat.isDirectory())) {
        throw new Error('scientific_expert_path_invalid');
      }
    }
  }
  return path;
}

function validateLock(lock) {
  const files = lock.sources?.flatMap(source => source.files);
  if (lock.schemaVersion !== 1 || !Array.isArray(files) || !files.length
    || new Set(files.map(file => file.path)).size !== files.length
    || files.some(file => !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || file.bytes > 128 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !file.url.startsWith('https://'))
    || files.reduce((sum, file) => sum + file.bytes, 0) > 256 * 1024 * 1024) {
    throw new Error('scientific_expert_lock_invalid');
  }
  files.forEach(file => capabilityRelativePath(file.path));
  return files;
}

export function verifyExpertPublicSources(root = defaultExpertPublicRoot, lock = readJson(expertPublicSourceLock)) {
  const files = validateLock(lock).map(pin => {
    const path = sourcePath(root, pin.path);
    if (!existsSync(path) || lstatSync(path).size !== pin.bytes
      || sha256(readFileSync(path)) !== pin.sha256) throw new Error(`scientific_expert_source_changed:${pin.path}`);
    return {path: pin.path, bytes: pin.bytes, sha256: pin.sha256};
  });
  return {schemaVersion: 1, root: resolve(root), sourceLockHash: hash(lock), files,
    sources: lock.sources.map(({files, ...source}) => source), scientificBaselineReady: false};
}

/** Only locked bytes are fetched. Upstream dataset scripts are never executed. */
export async function acquireExpertPublicSources({root = defaultExpertPublicRoot, offline = false,
  lock = readJson(expertPublicSourceLock)} = {}) {
  const files = validateLock(lock);
  if (!existsSync(root) && !offline) mkdirSync(root, {recursive: true, mode: 0o700});
  for (const pin of files) {
    const path = sourcePath(root, pin.path, !offline);
    if (existsSync(path)) {
      if (lstatSync(path).size !== pin.bytes || sha256(readFileSync(path)) !== pin.sha256) {
        throw new Error(`scientific_expert_source_changed:${pin.path}`);
      }
      continue;
    }
    if (offline) throw new Error(`scientific_expert_source_missing:${pin.path}`);
    writeFileSync(path, await downloadLockedArtifact(pin), {flag: 'wx', mode: 0o600});
  }
  return verifyExpertPublicSources(root, lock);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {root: {type: 'string'}, offline: {type: 'boolean'},
    output: {type: 'string'}}, allowPositionals: false, strict: true});
  acquireExpertPublicSources({root: resolve(values.root ?? defaultExpertPublicRoot), offline: values.offline})
    .then(report => {
      if (values.output) {mkdirSync(dirname(resolve(values.output)), {recursive: true});writeJson(resolve(values.output), report);}
      console.log(JSON.stringify(report, null, 2));
    }).catch(error => {console.error(error.stack);process.exitCode = 1;});
}
