#!/usr/bin/env node
// Controller-only acquisition. Fetch exact locked bytes, never execute upstream
// Python, install packages, extract arbitrary archive paths, or create reviews.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync,
  rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_ROOT, fail, hash, readJson, sha256 } from '../../lib/common.mjs';
import { qasperSourceContract } from '../../lib/data.mjs';
import { capabilityRelativePath, capabilitySourceIds, verifyCapabilitySourceSnapshot } from './sources.mjs';

const lockUrl = new URL('../../datasets/sources.lock.json', import.meta.url);
const defaultRoot = join(EVAL_ROOT, 'local', 'sources');
const requireData = (condition, code) => { if (!condition) fail('data', code); };
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sourceLock = () => readJson(lockUrl);

function selectedSources(sourceIds) {
  requireData(Array.isArray(sourceIds) && sourceIds.length > 0
    && new Set(sourceIds).size === sourceIds.length, 'capability_acquisition_sources_invalid');
  const lock = sourceLock();
  return sourceIds.map(id => {
    const source = lock.sources.find(value => value.id === id);
    requireData(source, 'capability_acquisition_source_unknown');
    capabilityRelativePath(source.id);
    if (source.revision !== null) capabilityRelativePath(source.revision);
    return source;
  });
}

/** A read-only bounded plan. Pending pins remain pending, without guessed SHAs. */
export function capabilitySourceAcquisitionPlan(sourceIds = capabilitySourceIds) {
  const sources = selectedSources(sourceIds);
  return {
    schemaVersion: 1, sources: sources.map(source => ({
      id: source.id, status: source.status, revision: source.revision,
      sourceLockHash: hash(source), license: source.license,
      bytes: source.artifacts.reduce((sum, file) => sum + file.bytes, 0),
      downloadBytes: source.artifacts.filter(file => file.url).reduce((sum, file) => sum + file.bytes, 0),
      files: source.artifacts.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256,
        ...(file.archiveMember ? { archiveMember: file.archiveMember } : {}) })),
      adaptation: structuredClone(source.adaptation ?? { status: source.status === 'verified' ? 'existing-adapter' : 'pending' }),
      unresolved: structuredClone(source.unresolved ?? []), humanReview: 'pending', scientificQuality: false
    }))
  };
}

function childPath(root, path, { createParents = false } = {}) {
  capabilityRelativePath(path);
  const canonicalRoot = realpathSync(root), parts = path.split('/');
  let current = canonicalRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    if (createParents && index < parts.length - 1 && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
    if (existsSync(current)) {
      const stat = lstatSync(current);
      requireData(!stat.isSymbolicLink()
        && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), 'capability_acquisition_path_escape');
      const local = relative(canonicalRoot, realpathSync(current));
      requireData(local !== '..' && !local.startsWith(`..${sep}`), 'capability_acquisition_path_escape');
    }
  }
  return current;
}

function verifyBytes(pin, bytes) {
  requireData(Number.isSafeInteger(pin.bytes) && pin.bytes >= 0 && pin.bytes <= 128 * 1024 * 1024
    && bytes.length === pin.bytes && sha256(bytes) === pin.sha256, 'capability_acquisition_hash_mismatch');
  if (pin.gitBlobSha1) requireData(gitBlob(bytes) === pin.gitBlobSha1, 'capability_acquisition_git_blob_mismatch');
  if (pin.lfsSha256) requireData(sha256(bytes) === pin.lfsSha256, 'capability_acquisition_lfs_mismatch');
}

function archiveBytes(root, pin) {
  capabilityRelativePath(pin.archiveMember.path);
  try {
    return execFileSync('/usr/bin/tar', ['-xOzf', childPath(root, pin.archiveMember.archive), pin.archiveMember.path],
      { maxBuffer: pin.bytes + 1024 });
  } catch { fail('data', 'capability_acquisition_archive_member_invalid'); }
}

function verifySnapshot(source, root) {
  requireData(existsSync(root) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
    'capability_acquisition_snapshot_missing');
  for (const pin of source.artifacts) {
    const path = childPath(root, pin.path);
    requireData(existsSync(path) && lstatSync(path).size === pin.bytes, 'capability_acquisition_hash_mismatch');
    const bytes = readFileSync(path);
    verifyBytes(pin, bytes);
    if (pin.archiveMember) {
      const original = archiveBytes(root, pin);
      verifyBytes(pin, original);
      requireData(original.equals(bytes), 'capability_acquisition_archive_member_changed');
    }
  }
  if (source.id !== 'qasper') return verifyCapabilitySourceSnapshot(root, source.id);
  const contract = qasperSourceContract();
  requireData(source.verification.kind === 'existing-locked-official-adapter'
    && source.revision === contract.source.version && source.license === contract.source.license
    && source.artifacts.some(file => file.path === 'source.tgz' && file.sha256 === contract.source.archiveSha256)
    && source.artifacts.some(file => file.path === contract.source.member && file.sha256 === contract.source.memberSha256),
  'capability_acquisition_qasper_contract_changed');
  return { dataset: source.id, revision: source.revision, sourceLockHash: hash(source),
    sourceVerified: true, humanReview: 'pending', scientificQuality: false,
    files: source.artifacts.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    adaptation: { status: 'existing-adapter' } };
}

export async function downloadLockedArtifact(pin, fetcher = globalThis.fetch) {
  const url = new URL(pin.url);
  requireData(url.protocol === 'https:' && !url.username && !url.password
    && ['raw.githubusercontent.com', 'huggingface.co', 'scifact.s3-us-west-2.amazonaws.com',
      'qasper-dataset.s3.us-west-2.amazonaws.com', 'arxiv.org', 'allenai.org',
      'aclanthology.org'].includes(url.hostname), 'capability_acquisition_url_untrusted');
  const response = await fetcher(url.href, { signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'Roc-evaluation-source-acquisition/1' } });
  requireData(response.ok && response.body, 'capability_acquisition_fetch_failed');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      requireData(size <= pin.bytes, 'capability_acquisition_download_too_large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error.failureClass) throw error;
    fail('data', 'capability_acquisition_fetch_incomplete');
  }
  const bytes = Buffer.concat(chunks, size);
  verifyBytes(pin, bytes);
  return bytes;
}

/**
 * Acquire only artifacts already fixed in sources.lock.json. Existing snapshots
 * are verified without network access or repair. `offline:true` is verify-only.
 * Optional fetcher permits transport testing; exact trusted hashes still bind
 * every response. Result never grants review, task fidelity or science quality.
 */
export async function acquireCapabilitySources({ sourceIds = capabilitySourceIds, root = defaultRoot,
  offline = false, maxBytes = 64 * 1024 * 1024, fetcher = globalThis.fetch } = {}) {
  const sources = selectedSources(sourceIds);
  requireData(sources.every(source => source.status === 'verified' && source.artifacts.length > 0),
    'capability_acquisition_source_pending');
  requireData(Number.isSafeInteger(maxBytes) && maxBytes > 0
    && sources.reduce((sum, source) => sum + source.artifacts.reduce((size, file) => size + file.bytes, 0), 0) <= maxBytes,
  'capability_acquisition_byte_budget_exceeded');
  root = resolve(root);
  if (!existsSync(root)) {
    requireData(!offline, 'capability_acquisition_snapshot_missing');
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  requireData(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'capability_acquisition_path_escape');
  const results = [];
  for (const source of sources) {
    const parent = join(root, source.id), target = join(parent, source.revision);
    if (existsSync(parent)) requireData(lstatSync(parent).isDirectory()
      && !lstatSync(parent).isSymbolicLink(), 'capability_acquisition_path_escape');
    if (existsSync(target)) {
      results.push({ ...verifySnapshot(source, target), root: target, acquired: false });
      continue;
    }
    requireData(!offline, 'capability_acquisition_snapshot_missing');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const lease = join(parent, `.${source.revision}.acquire.lock`);
    try { writeFileSync(lease, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
    catch { fail('data', 'capability_acquisition_already_owned'); }
    const stage = join(parent, `.acquiring-${source.revision}-${randomUUID()}`);
    try {
      if (existsSync(target)) {
        results.push({ ...verifySnapshot(source, target), root: target, acquired: false });
        continue;
      }
      mkdirSync(stage, { mode: 0o700 });
      for (const pin of source.artifacts.filter(file => !file.archiveMember)) {
        let bytes;
        const retained = source.id === 'qasper' && pin.role === 'archive'
          ? join(parent, `${pin.sha256}.tgz`) : null;
        if (retained && existsSync(retained)) {
          bytes = readFileSync(childPath(parent, `${pin.sha256}.tgz`));
          verifyBytes(pin, bytes);
        } else {
          requireData(typeof pin.url === 'string' && typeof fetcher === 'function', 'capability_acquisition_url_missing');
          bytes = await downloadLockedArtifact(pin, fetcher);
        }
        writeFileSync(childPath(stage, pin.path, { createParents: true }), bytes, { flag: 'wx', mode: 0o600 });
      }
      for (const pin of source.artifacts.filter(file => file.archiveMember)) {
        const bytes = archiveBytes(stage, pin);
        verifyBytes(pin, bytes);
        writeFileSync(childPath(stage, pin.path, { createParents: true }), bytes, { flag: 'wx', mode: 0o600 });
      }
      const proof = verifySnapshot(source, stage);
      requireData(!existsSync(target), 'capability_acquisition_target_appeared');
      renameSync(stage, target);
      results.push({ ...proof, root: target, acquired: true });
    } finally {
      // Only our UUID staging and exclusively created lease are removed.
      rmSync(stage, { recursive: true, force: true });
      rmSync(lease, { force: true });
    }
  }
  return { schemaVersion: 1, sourceLockHash: hash(sourceLock()), offline, sources: results };
}

async function main(args) {
  const sourceIds = [];
  let root = defaultRoot, offline = false, plan = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--source') sourceIds.push(args[++index]);
    else if (arg === '--root') root = args[++index];
    else if (arg === '--offline') offline = true;
    else if (arg === '--plan') plan = true;
    else if (arg !== '--all-p0') fail('data', 'capability_acquisition_argument_unknown');
  }
  requireData(typeof root === 'string' && root.length > 0, 'capability_acquisition_root_required');
  const ids = sourceIds.length ? sourceIds : capabilitySourceIds;
  const result = plan ? capabilitySourceAcquisitionPlan(ids) : await acquireCapabilitySources({ sourceIds: ids, root, offline });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
