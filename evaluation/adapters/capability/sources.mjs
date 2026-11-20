import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail, hash, sha256 } from '../../lib/common.mjs';
import { loadDataset, qasperSourceContract } from '../../lib/data.mjs';
import { importQasper, qasperInput } from '../../lib/qasper.mjs';

export const capabilitySourceIds = Object.freeze([
  'bfcl', 'toolsandbox', 'longmemeval-v2', 'locomo', 'scifact',
  'qasper', 'scienceagentbench-verified', 'agentdojo', 'injecagent'
]);
const formats = new Set(['json', 'jsonl', 'text', 'bytes']);
const roles = new Set(['records', 'ground-truth', 'corpus', 'history', 'license', 'asset', 'environment', 'grader', 'archive', 'provenance']);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const badKeys = new Set(['__proto__', 'prototype', 'constructor']);
const sourceLock = () => JSON.parse(readFileSync(new URL('../../datasets/sources.lock.json', import.meta.url), 'utf8'));
const requireData = (condition, code) => { if (!condition) fail('data', code); };
const gitObjectHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

export function capabilityRelativePath(value) {
  requireData(nonempty(value) && !isAbsolute(value) && !/[:\\\u0000-\u001f\u007f]/u.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..'), 'capability_path_escape');
  return value;
}
function safeFile(root, path) {
  capabilityRelativePath(path);
  const canonicalRoot = realpathSync(root);
  requireData(!lstatSync(root).isSymbolicLink(), 'capability_source_symlink');
  let target = canonicalRoot;
  for (const part of path.split('/')) {
    target = join(target, part);
    requireData(!lstatSync(target).isSymbolicLink(), 'capability_source_symlink');
  }
  const rel = relative(canonicalRoot, realpathSync(target));
  requireData(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && lstatSync(target).isFile(),
    'capability_source_path_escape');
  requireData(lstatSync(target).size <= 128 * 1024 * 1024, 'capability_source_file_too_large');
  return target;
}
function parse(bytes, format) {
  if (format === 'bytes') return null;
  const text = bytes.toString('utf8');
  if (format === 'text') return text;
  try {
    return format === 'jsonl' ? text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(text);
  } catch { fail('data', 'capability_original_source_invalid_json'); }
}
function select(value, path) {
  requireData(Array.isArray(path) && path.every(part => typeof part === 'string' && !badKeys.has(part)),
    'capability_source_pointer_invalid');
  let selected = value;
  for (const part of path) {
    requireData(selected !== null && typeof selected === 'object' && Object.hasOwn(selected, part),
      'capability_source_pointer_missing');
    selected = selected[part];
  }
  requireData(selected !== undefined && selected !== null && !(typeof selected === 'string' && !selected.trim()),
    'capability_source_reference_empty');
  return structuredClone(selected);
}
function refValue(files, ref) {
  requireData(object(ref) && nonempty(ref.file), 'capability_source_reference_invalid');
  const file = files.get(capabilityRelativePath(ref.file));
  requireData(file && file.format !== 'bytes', 'capability_source_reference_missing');
  return select(file.value, ref.path);
}
function bind(template, files) {
  if (Array.isArray(template)) return template.map(value => bind(value, files));
  if (!object(template)) return template;
  requireData(!Object.keys(template).some(key => badKeys.has(key)), 'capability_source_template_invalid');
  if (Object.hasOwn(template, '$source')) {
    requireData(Object.keys(template).every(key => ['$source', 'encoding'].includes(key)), 'capability_source_template_invalid');
    const value = refValue(files, template.$source);
    if (template.encoding === 'json') return JSON.stringify(value, null, 2) + '\n';
    if (template.encoding === 'text-lines') {
      requireData(Array.isArray(value) && value.length > 0 && value.every(nonempty),
        'capability_source_text_lines_binding_invalid');
      // Text-native research corpora trim their outer whitespace. Keep the
      // original sentence order and interior bytes in a declared conversion.
      return value.join('\n').trim();
    }
    if (template.encoding === 'text') {
      requireData(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
        'capability_source_text_binding_invalid');
      return String(value);
    }
    requireData(template.encoding === undefined, 'capability_source_encoding_invalid');
    return value;
  }
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, bind(value, files)]));
}
function descriptor(file) {
  return { path: file.path, sha256: file.sha256, format: file.format, role: file.role,
    ...(file.license === undefined ? {} : { license: file.license }) };
}
/** Content-addressed local snapshot, not an assertion of upstream authenticity. */
export function localSourceRevision(files) {
  return `sha256:${hash(files.map(descriptor).sort((a, b) => a.path.localeCompare(b.path)))}`;
}
function verifyLicense(id, text) {
  const patterns = {
    MIT: /MIT License|SPDX-License-Identifier:\s*MIT\b/u,
    'Apache-2.0': /Apache License[\s\S]*Version 2\.0|SPDX-License-Identifier:\s*Apache-2\.0\b/u,
    'BSD-3-Clause': /BSD 3-Clause|SPDX-License-Identifier:\s*BSD-3-Clause\b/u,
    'CC-BY-4.0': /Creative Commons Attribution 4\.0|CC[- ]BY[- ]4\.0|SPDX-License-Identifier:\s*CC-BY-4\.0\b|^license:\s*cc-by-4\.0\s*$/imu,
    'CC0-1.0': /CC0 1\.0|CC0-1\.0|Creative Commons Zero/u,
    'CC-BY-SA-4.0': /Creative Commons Attribution-ShareAlike 4\.0|CC-BY-SA-4\.0/u,
    'CC-BY-NC-4.0': /(?:Creative Commons )?Attribution-NonCommercial 4\.0|CC-BY-NC-4\.0/u,
    'LicenseRef-Apple-ToolSandbox': /Copyright \(C\) 2024 Apple Inc\.[\s\S]*Apple grants you a personal, non-exclusive[\s\S]*ACKNOWLEDGEMENTS/u,
    'CC-BY-4.0 AND ODC-By-1.0': /CC BY 4\.0[\s\S]*ODC-By 1\.0/u
  };
  requireData(Object.hasOwn(patterns, id) && patterns[id].test(text), 'capability_source_license_unverified');
}
function lockedOriginals(dataset, revision, license, files) {
  const locked = sourceLock().sources.find(source => source.id === dataset);
  if (locked?.status !== 'verified' || locked.revision !== revision || locked.license !== license) return null;
  if (!locked.verification || !locked.licenseFile || !files.has(locked.licenseFile)) return null;
  for (const file of files.values()) {
    const pin = locked.artifacts.find(value => value.path === file.path);
    if (!pin || pin.sha256 !== file.sha256 || pin.bytes !== file.bytes.length
      || pin.format !== file.format || pin.role !== file.role || pin.license !== file.license) return null;
    if (pin.gitBlobSha1 && gitObjectHash('blob', file.bytes) !== pin.gitBlobSha1) return null;
    if (pin.lfsSha256 && sha256(file.bytes) !== pin.lfsSha256) return null;
    if (pin.archiveMember && !files.has(pin.archiveMember.archive)) return null;
  }
  return locked;
}
function lockedOrigin(locked) {
  return { kind: 'locked-public-snapshot', sourceLockHash: hash(locked),
    verification: locked.verification.kind };
}
function verifyLockedArchiveMembers(locked, files, root) {
  for (const pin of locked.artifacts.filter(value => value.archiveMember && files.has(value.path))) {
    const archive = safeFile(root, pin.archiveMember.archive);
    capabilityRelativePath(pin.archiveMember.path);
    const bytes = execFileSync('/usr/bin/tar', ['-xOzf', archive, pin.archiveMember.path],
      { maxBuffer: 128 * 1024 * 1024 });
    requireData(sha256(bytes) === pin.sha256 && bytes.equals(files.get(pin.path).bytes),
      'capability_source_archive_member_changed');
  }
}
/** Build an explicit import spec from the byte-verified control-plane lock. No fetch or human review. */
export function capabilityLockedSourceSpec(dataset, { root, mappings, paths } = {}) {
  const locked = sourceLock().sources.find(source => source.id === dataset);
  requireData(locked?.status === 'verified' && locked.licenseFile
    && capabilitySourceIds.includes(dataset) && dataset !== 'qasper', 'capability_locked_source_unavailable');
  requireData(nonempty(root), 'capability_original_source_required');
  requireData(paths === undefined || Array.isArray(paths) && paths.every(nonempty),
    'capability_locked_source_path_missing');
  const selected = paths === undefined ? locked.artifacts : locked.artifacts.filter(file => paths.includes(file.path));
  requireData(paths === undefined || Array.isArray(paths) && selected.length === new Set(paths).size,
    'capability_locked_source_path_missing');
  return { dataset, root, revision: locked.revision, license: { id: locked.license,
    file: locked.licenseFile, sha256: locked.artifacts.find(file => file.path === locked.licenseFile).sha256 },
  attribution: locked.attribution, files: selected.map(descriptor),
  ...(mappings === undefined ? {} : { mappings }) };
}
/** Verify acquired originals without constructing or qualifying any tasks. */
export function verifyCapabilitySourceSnapshot(root, dataset) {
  const spec = capabilityLockedSourceSpec(dataset, { root });
  const { files } = readOriginals(spec, process.cwd());
  const locked = lockedOriginals(dataset, spec.revision, spec.license.id, files);
  requireData(locked, 'capability_locked_source_bytes_unverified');
  verifyLockedArchiveMembers(locked, files, root);
  return { dataset, revision: locked.revision, sourceLockHash: hash(locked),
    files: [...files.values()].map(file => ({ ...descriptor(file), bytes: file.bytes.length })),
    sourceVerified: true, humanReview: 'pending', scientificQuality: false,
    adaptation: structuredClone(locked.adaptation ?? { status: 'pending' }) };
}
function readOriginals(spec, baseDir) {
  requireData(nonempty(spec.root) && Array.isArray(spec.files) && spec.files.length > 0,
    'capability_original_source_required');
  const root = resolve(baseDir, spec.root), files = new Map();
  for (const file of spec.files) {
    requireData(object(file) && formats.has(file.format) && roles.has(file.role) && digest(file.sha256),
      'capability_source_file_pin_invalid');
    const path = capabilityRelativePath(file.path);
    requireData(!files.has(path), 'capability_source_file_duplicate');
    const bytes = readFileSync(safeFile(root, path));
    requireData(sha256(bytes) === file.sha256, 'capability_source_hash_mismatch');
    files.set(path, { ...descriptor(file), bytes, value: parse(bytes, file.format) });
  }
  requireData(object(spec.license) && nonempty(spec.license.id) && nonempty(spec.attribution),
    'capability_source_license_required');
  const license = files.get(spec.license.file);
  requireData(license?.role === 'license' && license.format === 'text' && license.sha256 === spec.license.sha256,
    'capability_source_license_pin_invalid');
  verifyLicense(spec.license.id, license.value);
  const contentRevision = localSourceRevision([...files.values()]);
  const publicSnapshot = lockedOriginals(spec.dataset, spec.revision, spec.license.id, files);
  let gitProof, origin;
  if (spec.revision?.startsWith('sha256:')) {
    requireData(spec.revision === contentRevision, 'capability_source_revision_mismatch');
  } else if (publicSnapshot) {
    verifyLockedArchiveMembers(publicSnapshot, files, root);
    origin = lockedOrigin(publicSnapshot);
  } else {
    requireData(typeof spec.revision === 'string' && /^[a-f0-9]{40}$/u.test(spec.revision), 'capability_source_revision_unpinned');
    try {
      const commit = execFileSync('git', ['rev-parse', '--verify', `${spec.revision}^{commit}`],
        { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
      requireData(commit === spec.revision, 'capability_source_revision_mismatch');
      const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'],
        { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
      const gitBytes = (kind, oid) => execFileSync('git', ['cat-file', kind, oid],
        { cwd: root, maxBuffer: 128 * 1024 * 1024 });
      const commitBytes = gitBytes('commit', commit), trees = new Map(), paths = [];
      const treeId = /^tree ([a-f0-9]{40})\n/u.exec(commitBytes.toString('utf8'))?.[1];
      requireData(treeId, 'capability_source_git_tree_missing');
      for (const file of files.values()) {
        const gitPath = relative(realpathSync(repositoryRoot), realpathSync(join(root, file.path))).split(sep).join('/');
        const committed = execFileSync('git', ['show', `${commit}:${gitPath}`],
          { cwd: root, maxBuffer: 128 * 1024 * 1024 });
        requireData(sha256(committed) === file.sha256, 'capability_source_git_bytes_changed');
        let current = treeId;
        const parts = gitPath.split('/');
        for (const [index, part] of parts.entries()) {
          if (!trees.has(current)) trees.set(current, gitBytes('tree', current));
          const entry = gitTreeEntries(trees.get(current)).find(value => value.name === part);
          requireData(entry, 'capability_source_git_path_missing');
          if (index < parts.length - 1) {
            requireData(entry.mode === '40000', 'capability_source_git_path_invalid');
            current = entry.oid;
          } else requireData(['100644', '100755'].includes(entry.mode)
            && entry.oid === gitObjectHash('blob', file.bytes), 'capability_source_git_blob_invalid');
        }
        paths.push({ path: file.path, gitPath });
      }
      gitProof = { schemaVersion: 1, revision: commit, commit: commitBytes.toString('base64'),
        trees: [...trees].map(([oid, bytes]) => ({ oid, content: bytes.toString('base64') })), paths };
    } catch (error) {
      if (error.failureClass) throw error;
      fail('data', 'capability_source_git_revision_unverified');
    }
  }
  return { files, contentRevision, gitProof, origin };
}
function gitTreeEntries(bytes) {
  const values = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1);
    requireData(space > offset && nul > space && nul + 21 <= bytes.length, 'capability_source_git_tree_invalid');
    const mode = bytes.subarray(offset, space).toString('ascii'), name = bytes.subarray(space + 1, nul).toString('utf8');
    requireData(nonempty(name) && !name.includes('/') && !['.', '..'].includes(name),
      'capability_source_git_tree_invalid');
    values.push({ mode, name, oid: bytes.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return values;
}
function verifyGitProof(source, files) {
  const proof = source.gitProof;
  requireData(object(proof) && proof.schemaVersion === 1 && proof.revision === source.revision
    && Array.isArray(proof.trees) && Array.isArray(proof.paths) && proof.paths.length === files.size,
  'capability_source_git_revision_unverified');
  const decode = value => {
    requireData(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/u.test(value), 'capability_source_git_proof_invalid');
    const bytes = Buffer.from(value, 'base64');
    requireData(bytes.toString('base64') === value, 'capability_source_git_proof_invalid');
    return bytes;
  };
  const commit = decode(proof.commit), trees = new Map();
  requireData(gitObjectHash('commit', commit) === source.revision, 'capability_source_git_commit_changed');
  const root = /^tree ([a-f0-9]{40})\n/u.exec(commit.toString('utf8'))?.[1];
  requireData(root, 'capability_source_git_tree_missing');
  for (const tree of proof.trees) {
    const bytes = decode(tree.content);
    requireData(!trees.has(tree.oid) && gitObjectHash('tree', bytes) === tree.oid, 'capability_source_git_tree_changed');
    trees.set(tree.oid, gitTreeEntries(bytes));
  }
  const seen = new Set();
  for (const path of proof.paths) {
    capabilityRelativePath(path.path); capabilityRelativePath(path.gitPath);
    requireData(files.has(path.path) && !seen.has(path.path), 'capability_source_git_path_invalid');
    seen.add(path.path);
    let current = root;
    const parts = path.gitPath.split('/');
    for (const [index, part] of parts.entries()) {
      const entry = trees.get(current)?.find(value => value.name === part);
      requireData(entry, 'capability_source_git_path_missing');
      if (index < parts.length - 1) {
        requireData(entry.mode === '40000', 'capability_source_git_path_invalid');
        current = entry.oid;
      } else requireData(['100644', '100755'].includes(entry.mode)
        && entry.oid === gitObjectHash('blob', files.get(path.path).bytes), 'capability_source_git_blob_invalid');
    }
  }
}
function originalId(record, ref, mapping) {
  if (mapping.idPath) return String(select(record, mapping.idPath));
  for (const key of ['question_id', 'instance_id', 'task_id', 'id']) {
    if (object(record) && (nonempty(record[key]) || typeof record[key] === 'number')) return String(record[key]);
  }
  // Some upstream QA rows have no IDs. A coordinate is a real raw identity.
  return `${ref.file}#/${ref.path.map(part => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}
function scalarKeys(value, prefix) {
  if (Array.isArray(value)) return value.flatMap(item => scalarKeys(item, prefix));
  requireData(nonempty(value) || typeof value === 'number' || object(value), 'capability_cluster_reference_invalid');
  return [`${prefix}:${object(value) ? hash(value) : String(value)}`];
}
function nativeClusters(dataset, record, mapping, files) {
  const keys = [];
  const shared = (kind, value) => {
    if (Array.isArray(value)) { value.forEach(item => shared(kind, item)); return; }
    if (typeof value !== 'string') return;
    const normalized = value.trim().toLowerCase().replace(/\/+$/u, '');
    const doi = normalized.replace(/^https?:\/\/(?:dx\.)?doi\.org\/|^doi:\s*/u, '');
    const arxiv = /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/u.exec(normalized);
    if (kind === 'doi' || /^10\.\d{4,9}\//u.test(doi)) {
      requireData(/^10\.\d{4,9}\/\S+$/u.test(doi), 'capability_cluster_doi_invalid');
      keys.push(`shared:doi:${doi}`);
    } else if (kind === 'arxiv' || arxiv) {
      requireData(arxiv, 'capability_cluster_arxiv_invalid');
      keys.push(`shared:arxiv:${arxiv[1]}`);
    } else if (kind === 'repository' || kind === 'repository-url') {
      if (/^https:\/\/(?:github\.com|gitlab\.com)\/[^/]+\/[^/]+(?:\.git)?$/u.test(normalized)) {
        keys.push(`shared:repository:${normalized.replace(/\.git$/u, '')}`);
      } else if (kind === 'repository-url') fail('data', 'capability_cluster_repository_invalid');
    }
  };
  const add = (kind, value) => {
    if (value === undefined || value === null) return;
    keys.push(...scalarKeys(value, `${dataset}:${kind}`));
    shared(kind, value);
  };
  for (const ref of mapping.clusterRefs ?? []) {
    requireData(object(ref) && nonempty(ref.kind), 'capability_cluster_reference_invalid');
    add(ref.kind, refValue(files, ref));
  }
  if (dataset === 'scifact') {
    add('paper', Object.keys(record.evidence ?? {}));
    add('paper', record.cited_doc_ids);
    add('paper', record.doc_ids);
  } else if (dataset === 'locomo') {
    add('conversation', record.sample_id ?? record.conversation_id);
    if (record.conversation) add('history', record.conversation);
  } else if (dataset === 'longmemeval-v2') {
    add('history', record.history_id ?? record.trajectory_id ?? record.haystack_id);
    add('session', record.haystack_session_ids);
    if (record.haystack_sessions) add('history-content', { sessions: record.haystack_sessions });
    if (mapping.haystackRef) add('trajectory', refValue(files, mapping.haystackRef));
  } else if (dataset === 'scienceagentbench-verified') {
    add('paper', record.paper_id ?? record.paper_url ?? record.paper);
    add('repository', record.repository ?? record.repo_url ?? record.repository_url);
  } else if (dataset === 'agentdojo') {
    add('base-task', record.user_task_id ?? record.base_task_id ?? record.task_id);
  } else if (dataset === 'injecagent') {
    const instruction = record['User Instruction'] ?? record.user_instruction ?? record.user_task;
    if (instruction) add('base-task', { instruction, tool: record['User Tool'] ?? record.user_tool ?? null });
  } else if (dataset === 'toolsandbox') {
    add('scenario', record.base_scenario ?? record.scenario_id ?? record.name);
  } else if (dataset === 'bfcl') {
    add('scenario', record.scenario_id ?? record.base_task_id);
    if (record.function ?? record.functions) add('function-schema', { functions: record.function ?? record.functions });
    for (const ref of mapping.functionRefs ?? []) add('function-schema', refValue(files, ref));
  }
  requireData(keys.length > 0, 'capability_source_cluster_required');
  return [...new Set(keys)].sort();
}
function nativeEvidence(spec, mapping, record, files) {
  const refs = [];
  const pin = (kind, ref) => {
    const value = refValue(files, ref);
    refs.push({ kind, file: ref.file, path: ref.path, sha256: hash(value) });
    return value;
  };
  const reference = (name, keys) => {
    const explicit = mapping[`${name}Ref`];
    if (explicit) return explicit;
    const key = keys.find(key => Object.hasOwn(record, key));
    requireData(key, `capability_${name}_original_reference_required`);
    return { file: mapping.record.file, path: [...mapping.record.path, key] };
  };
  if (['longmemeval-v2', 'locomo'].includes(spec.dataset)) {
    const history = pin('complete-history', reference('history',
      spec.dataset === 'locomo' ? ['conversation', 'history'] : ['haystack_sessions', 'history', 'trajectory']));
    const hasObservation = value => {
      if (Array.isArray(value)) return value.length > 0 && value.some(hasObservation);
      if (!object(value)) return false;
      if (['content', 'text', 'accessibility_tree'].some(key => nonempty(value[key]))) return true;
      return Object.values(value).some(child => (Array.isArray(child) || object(child)) && hasObservation(child));
    };
    requireData(hasObservation(history), 'capability_complete_history_required');
    // V2 haystacks are trajectory IDs, not the original histories. An ID list
    // must never masquerade as the states/accessibility observations it names.
    if (spec.dataset === 'longmemeval-v2' && Object.hasOwn(record, 'eval_function')) {
      requireData(mapping.haystackRef && Array.isArray(history)
        && history.every(trajectory => object(trajectory) && nonempty(trajectory.id)
          && Array.isArray(trajectory.states) && trajectory.states.length > 0 && hasObservation(trajectory.states)),
      'capability_longmemeval_v2_trajectories_required');
      const expectedIds = pin('haystack-identities', mapping.haystackRef);
      requireData(Array.isArray(expectedIds) && expectedIds.length > 0 && expectedIds.every(nonempty)
        && new Set(expectedIds).size === expectedIds.length
        && expectedIds.length === history.length
        && expectedIds.every(id => history.some(trajectory => trajectory.id === id)),
      'capability_longmemeval_v2_history_incomplete');
    }
  }
  if (spec.dataset === 'scifact') {
    requireData(Array.isArray(mapping.corpusRefs) && mapping.corpusRefs.length > 0, 'capability_scifact_original_corpus_required');
    const documents = new Set();
    for (const ref of mapping.corpusRefs) {
      requireData(files.get(ref.file)?.role === 'corpus', 'capability_scifact_corpus_role_invalid');
      const value = pin('corpus-document', ref);
      requireData(object(value) && (value.doc_id !== undefined || value.id !== undefined), 'capability_scifact_corpus_id_required');
      documents.add(String(value.doc_id ?? value.id));
    }
    const ids = [...Object.keys(record.evidence ?? {}), ...(record.cited_doc_ids ?? []), ...(record.doc_ids ?? [])].map(String);
    requireData(ids.every(id => documents.has(id)), 'capability_scifact_cited_corpus_missing');
  }
  if (['agentdojo', 'injecagent'].includes(spec.dataset)) {
    pin('benign-task', reference('benignTask', ['user_task', 'user_instruction', 'User Instruction', 'user_task_description']));
    pin('attacker-objective', reference('attackerObjective',
      ['attacker_goal', 'attacker_objective', 'Attacker Objective', 'Expected Achievements', 'Attacker Instruction', 'attacker_instruction']));
    pin('untrusted-attack-payload', reference('attackPayload',
      ['attack_payload', 'injection', 'Attacker Instruction', 'attacker_instruction', 'attack']));
  }
  if (spec.dataset === 'bfcl') {
    let functions = record.function ?? record.functions;
    if (functions === undefined && Array.isArray(mapping.functionRefs)) {
      requireData(Array.isArray(record.involved_classes) && record.involved_classes.includes('GorillaFileSystem'),
        'capability_bfcl_original_functions_required');
      functions = mapping.functionRefs.map(ref => pin('function-schema', ref));
    }
    requireData(Array.isArray(functions) && functions.length > 0 && object(mapping.toolMap)
      && Object.keys(mapping.toolMap).length > 0, 'capability_bfcl_original_functions_required');
    requireData(functions.every(value => object(value) && nonempty(value.name)),
      'capability_bfcl_original_functions_required');
    const names = new Set(functions.map(value => value.name));
    requireData(Object.keys(mapping.toolMap).every(name => names.has(name))
      && Object.values(mapping.toolMap).every(nonempty), 'capability_bfcl_function_not_original');
    for (const ref of mapping.groundTruth) {
      const file = files.get(ref.file);
      if (file?.role !== 'ground-truth' || !Array.isArray(file.value) || !ref.path.length) continue;
      const answerRecord = select(file.value, [ref.path[0]]);
      requireData(object(answerRecord) && answerRecord.id === mapping.originalTaskId,
        'capability_bfcl_answer_identity_mismatch');
    }
  }
  return refs;
}
function boundLabel(mapping, record, files, name, recordKey) {
  const ref = mapping[`${name}Ref`];
  const actual = ref ? refValue(files, ref) : record[recordKey];
  requireData(actual !== undefined && (mapping[name] === undefined || mapping[name] === actual),
    `capability_${name}_not_bound_to_original`);
  return actual;
}
function sourceUnsupported(spec, mapping, record, task) {
  const sessionMemory = task.environment?.session?.schemaVersion === 1
    && task.expected?.checks?.some(check => check.kind === 'memory' && check.required !== false);
  const context = task.expected?.checks?.some(check => check.kind === 'context' && check.required !== false
    && (check.stage === 'summary' && task.environment?.session?.schemaVersion === 1
      || check.stage === 'tool-offload' && task.environment?.tools?.includes('read_context_artifact')));
  if (spec.dataset === 'longmemeval-v2') {
    requireData(boundLabel(mapping, record, spec.filesMap, 'domain', 'domain') === 'enterprise', 'capability_memory_domain_not_enterprise');
    return record.requires_screenshot || record.requires_browser || nonempty(record.image)
      ? 'memory_source_requires_unsupported_visual_or_browser_runtime'
      : sessionMemory || context ? null : 'production_memory_or_context_evidence_unavailable';
  }
  if (spec.dataset === 'locomo') return sessionMemory || context ? null : 'production_memory_or_context_evidence_unavailable';
  if (spec.dataset === 'scienceagentbench-verified') {
    requireData(boundLabel(mapping, record, spec.filesMap, 'upstreamSplit', 'split') === 'verified', 'capability_science_verified_split_required');
    return null;
  }
  return null;
}
function rejectVisibleTruthBindings(template, groundTruth, files) {
  const prefix = (left, right) => left.length <= right.length && left.every((value, index) => value === right[index]);
  const inspect = value => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (!object(value)) return;
    if (Object.hasOwn(value, '$source')) {
      const ref = value.$source;
      requireData(object(ref) && Array.isArray(ref.path), 'capability_source_reference_invalid');
      requireData(files.get(ref.file)?.role !== 'ground-truth'
        && !groundTruth.some(truth => truth.file === ref.file && (prefix(ref.path, truth.path) || prefix(truth.path, ref.path))),
      'capability_hidden_truth_source_binding');
    }
    Object.values(value).forEach(inspect);
  };
  inspect(template.visible); inspect(template.environment);
}
function scienceQualification(spec) {
  if (spec.dataset !== 'scienceagentbench-verified') return null;
  const rolesPresent = new Set(spec.files.map(file => file.role));
  const locked = sourceLock().sources.find(source => source.id === spec.dataset);
  const verifiedMetadata = locked?.status === 'verified' && locked.revision === spec.revision
    && locked.verification?.verifiedSplit === 'verified'
    && locked.artifacts.filter(file => file.role === 'records').some(pin =>
      spec.files.some(file => file.path === pin.path && file.sha256 === pin.sha256));
  return {
    status: 'pending', scientificQuality: false, split: 'verified',
    metadata: verifiedMetadata ? 'locked-official-verified-split-bytes'
      : rolesPresent.has('records') ? 'local-hash-verified' : 'missing',
    assets: rolesPresent.has('asset') ? 'local-hash-verified' : 'missing',
    environment: rolesPresent.has('environment') ? 'local-hash-verified-not-audited' : 'missing',
    officialGrader: rolesPresent.has('grader') ? 'local-hash-verified-origin-unverified' : 'missing',
    calibration: 'not-run', expertReview: 'pending',
    redistribution: 'do-not-publish-unpacked-assets',
    reason: 'Verified metadata is separate from assets, environment, independent grading, calibration and expert review.'
  };
}
function mappedTask(spec, mapping, files) {
  requireData(object(mapping) && object(mapping.record) && object(mapping.task)
    && nonempty(mapping.originalTaskId) && Array.isArray(mapping.groundTruth) && mapping.groundTruth.length > 0,
  'capability_source_mapping_incomplete');
  const record = refValue(files, mapping.record);
  requireData(object(record), 'capability_source_record_invalid');
  requireData(originalId(record, mapping.record, mapping) === mapping.originalTaskId,
    'capability_original_task_id_mismatch');
  const groundTruth = mapping.groundTruth.map(ref => {
    const value = refValue(files, ref);
    const emptySciFactEvidence = spec.dataset === 'scifact' && ref.path.at(-1) === 'evidence'
      && object(value) && Object.keys(value).length === 0;
    requireData(!Array.isArray(value) || value.length > 0, 'capability_ground_truth_missing');
    requireData(!object(value) || Object.keys(value).length > 0 || emptySciFactEvidence, 'capability_ground_truth_missing');
    return { file: ref.file, path: ref.path, sha256: hash(value) };
  });
  rejectVisibleTruthBindings(mapping.task, mapping.groundTruth, files);
  const task = bind(mapping.task, files);
  requireData(!Object.hasOwn(task, 'source'), 'capability_mapping_cannot_override_source');
  const toolMap = mapping.toolMap ?? {};
  requireData(object(toolMap), 'capability_tool_mapping_invalid');
  for (const check of task.expected?.checks ?? []) {
    if (check.kind === 'tool-call' && spec.dataset === 'bfcl') {
      requireData(Object.values(toolMap).includes(check.name), 'capability_bfcl_production_tool_mapping_required');
    }
  }
  const nativeRefs = nativeEvidence(spec, mapping, record, files);
  const unsupported = sourceUnsupported({ ...spec, filesMap: files }, mapping, record, task);
  let clusterKeys = nativeClusters(spec.dataset, record, mapping, files);
  for (const ref of nativeRefs) if (['complete-history', 'benign-task'].includes(ref.kind)) {
    clusterKeys.push(`${spec.dataset}:${ref.kind}:${ref.sha256}`);
  }
  if (spec.dataset === 'qasper') {
    const coordinate = mapping.record.path, member = qasperSourceContract().source.member;
    requireData(mapping.record.file === member && coordinate.length === 3 && coordinate[1] === 'qas'
      && /^\d+$/u.test(coordinate[2]) && mapping.qasperPaperId === coordinate[0]
      && files.get(member)?.value[coordinate[0]]?.qas[Number(coordinate[2])]?.question_id === mapping.originalTaskId,
    'capability_qasper_paper_identity_mismatch');
    clusterKeys = [`qasper:paper:${coordinate[0]}`];
    const arxiv = /^(\d{4}\.\d{4,5})(?:v\d+)?$/u.exec(coordinate[0]);
    if (arxiv) clusterKeys.push(`shared:arxiv:${arxiv[1]}`);
  }
  return {
    task: {
      ...task, schemaVersion: 2,
      source: { dataset: spec.dataset, revision: spec.revision, originalTaskId: mapping.originalTaskId,
        license: spec.license.id, attribution: spec.attribution, contentSha256: hash(record) },
      ...(unsupported ? { unsupported } : {})
    },
    original: { originalTaskId: mapping.originalTaskId, record: mapping.record, idPath: mapping.idPath ?? null,
      contentSha256: hash(record), groundTruth, nativeRefs, clusterKeys: [...new Set(clusterKeys)].sort() }
  };
}
/** Deterministic connected components, including links across multiple sources. */
export function assignCapabilityClusters(entries) {
  const parents = new Map();
  const find = key => {
    if (!parents.has(key)) parents.set(key, key);
    if (parents.get(key) !== key) parents.set(key, find(parents.get(key)));
    return parents.get(key);
  };
  for (const entry of entries) {
    const keys = entry.original.clusterKeys;
    for (const key of keys) parents.set(find(key), find(keys[0]));
  }
  const components = new Map();
  for (const key of parents.keys()) {
    const root = find(key);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(key);
  }
  for (const entry of entries) {
    const keys = components.get(find(entry.original.clusterKeys[0])).sort();
    entry.task.clusterId = `source-cluster-${hash(keys).slice(0, 32)}`;
    entry.original.clusterId = entry.task.clusterId;
  }
}
function qasperReuse(spec, baseDir) {
  requireData(nonempty(spec.datasetPath) && Array.isArray(spec.mappings) && spec.mappings.length > 0,
    'capability_qasper_reuse_mapping_required');
  const dataset = loadDataset(resolve(baseDir, spec.datasetPath));
  requireData(dataset.qasperQualification?.status === 'verified', 'capability_qasper_original_qualification_unverified');
  const contract = qasperSourceContract(), locked = contract.source;
  const raw = JSON.parse(readFileSync(join(dataset.root, locked.member), 'utf8'));
  const byId = new Map(dataset.tasks.map(task => [task.id, task]));
  const files = new Map();
  for (const [path, format, role] of [['source.tgz', 'bytes', 'archive'], [locked.member, 'json', 'records']]) {
    const bytes = readFileSync(safeFile(dataset.root, path));
    files.set(path, { path, format, role, sha256: sha256(bytes), bytes, value: parse(bytes, format) });
  }
  const normalized = { dataset: 'qasper', revision: locked.version, license: { id: locked.license },
    attribution: spec.attribution ?? 'QASPER, Allen Institute for AI; locked v0.3 development archive.',
    files: [...files.values()].map(descriptor), origin: { kind: 'locked-qasper', contractHash: contract.hash } };
  const mappings = spec.mappings.map(selection => {
    const old = byId.get(selection.originalTaskId);
    requireData(old, 'capability_qasper_original_task_missing');
    const paper = raw[old.clusterId], index = paper.qas.findIndex(qa => qa.question_id === old.id);
    requireData(index >= 0, 'capability_qasper_original_task_missing');
    const input = qasperInput(old);
    const paragraphs = old.visible.paragraphs;
    const first = old.references[0];
    const evidence = first.evidence.map(text => paragraphs.find(paragraph => paragraph.text === text)?.id);
    const checks = [
      { id: 'paper-read', kind: 'tool-call', name: 'read_file', args: { file_path: '/workspace/paper.json' }, min: 1 },
      { id: 'answer', kind: 'json-value', path: ['answer'], value: first.answer },
      { id: 'evidence', kind: 'json-value', path: ['evidence'], value: evidence.filter(Boolean) }
    ];
    // Preserve QASPER's native references for the controller; exact-value checks
    // are engineering diagnostics, not a replacement for its answer/evidence F1.
    const task = selection.task ?? {
      id: `qasper-${old.id}`, family: 'literature-verification', difficulty: 'moderate', split: old.split,
      capabilityTags: ['evidence_grounding', 'citation_generation'],
      visible: { prompt: input.prompt, files: input.files, outputContract: 'qasper-answer-evidence-v1' },
      environment: { tools: ['read_file'], network: 'disabled' },
      expected: { checks },
      review: { producer: 'roc-qasper-adaptation-v2', reviewers: [] }
    };
    requireData(task.family !== 'multi-paper-evidence-citation', 'capability_single_paper_cannot_be_multi_paper');
    return {
      originalTaskId: old.id,
      record: { file: locked.member, path: [old.clusterId, 'qas', String(index)] },
      groundTruth: [{ file: locked.member, path: [old.clusterId, 'qas', String(index), 'answers'] }],
      clusterRefs: [{ kind: 'paper', file: locked.member, path: [old.clusterId, 'title'] }],
      task: { ...task, ...(old.unsupported ? { unsupported: old.unsupported } : {}) },
      qasperPaperId: old.clusterId
    };
  });
  return { spec: normalized, files, mappings, contentRevision: localSourceRevision([...files.values()]) };
}
/**
 * imports[]: {dataset,root,revision,license:{id,file,sha256},attribution,
 * files:[{path,sha256,format,role}],mappings:[{originalTaskId,record:{file,path},
 * groundTruth:[{file,path}],clusterRefs:[{kind,file,path}],toolMap?,task}]}.
 * A task template can bind a raw value with {$source:{file,path},encoding?}.
 * qasper instead accepts {dataset:'qasper',datasetPath,mappings:[{originalTaskId,task?}]}.
 * Everything returned in controlFiles remains controller-only.
 */
export function importCapabilitySources(imports, { baseDir = process.cwd() } = {}) {
  requireData(Array.isArray(imports) && imports.length > 0, 'capability_source_imports_required');
  const controlFiles = {}, sources = [], entries = [];
  for (const [index, input] of imports.entries()) {
    requireData(object(input) && capabilitySourceIds.includes(input.dataset), 'capability_source_importer_unavailable');
    let spec = input, files, contentRevision, gitProof, origin, mappings = input.mappings;
    if (spec.dataset === 'qasper') {
      ({ spec, files, contentRevision, mappings } = qasperReuse(input, baseDir));
    } else {
      requireData(input.origin === undefined, 'capability_source_origin_cannot_be_asserted');
      ({ files, contentRevision, gitProof, origin } = readOriginals(spec, baseDir));
      requireData(Array.isArray(mappings) && mappings.length > 0, 'capability_explicit_mapping_required');
    }
    const prefix = `sources/${index}-${spec.dataset}`;
    const originalFiles = [...files.values()].map(descriptor);
    for (const file of files.values()) controlFiles[`${prefix}/original/${file.path}`] = file.bytes;
    const mappingBytes = Buffer.from(JSON.stringify(mappings, null, 2) + '\n');
    controlFiles[`${prefix}/mapping.json`] = mappingBytes;
    const source = {
      dataset: spec.dataset, revision: spec.revision, contentRevision, attribution: spec.attribution,
      license: spec.license, origin: spec.origin ?? origin ?? { kind: gitProof ? 'local-git-snapshot' : 'local-content-snapshot' },
      ...(gitProof ? { gitProof } : {}),
      originalFiles, prefix, mapping: { path: `${prefix}/mapping.json`, sha256: sha256(mappingBytes) },
      qualification: scienceQualification(spec), originals: []
    };
    for (const [mappingIndex, mapping] of mappings.entries()) {
      const entry = mappedTask(spec, mapping, files);
      entry.original.mappingIndex = mappingIndex;
      entry.original.taskId = entry.task.id;
      source.originals.push(entry.original);
      entries.push(entry);
    }
    sources.push(source);
  }
  assignCapabilityClusters(entries);
  for (const entry of entries) entry.original.taskHash = hash(entry.task);
  return { tasks: entries.map(entry => entry.task), sourceEvidence: { schemaVersion: 1, sources }, controlFiles };
}
function lockedUpstream(source, files, originalsRoot) {
  const locked = sourceLock().sources.find(item => item.id === source.dataset);
  if (locked?.status !== 'verified' || locked.revision !== source.revision || locked.license !== source.license.id) return false;
  if (source.dataset === 'qasper') {
    const contract = qasperSourceContract();
    if (source.origin.kind !== 'locked-qasper' || source.origin.contractHash !== contract.hash) return false;
    const archive = files.get('source.tgz'), member = files.get(contract.source.member);
    if (!archive || !member || archive.sha256 !== contract.source.archiveSha256 || member.sha256 !== contract.source.memberSha256) return false;
    const archived = execFileSync('/usr/bin/tar', ['-xOzf', safeFile(originalsRoot, 'source.tgz'), contract.source.member],
      { maxBuffer: 16 * 1024 * 1024 });
    requireData(sha256(archived) === member.sha256 && archived.equals(member.bytes), 'capability_qasper_archive_member_changed');
    // Native adaptation is reused. No caller-supplied official/verified flags.
    importQasper(member.value);
    return source.originalFiles.every(file => locked.artifacts.some(pin => pin.path === file.path && pin.sha256 === file.sha256));
  }
  const snapshot = lockedOriginals(source.dataset, source.revision, source.license.id, files);
  if (!snapshot) return false;
  verifyLockedArchiveMembers(snapshot, files, originalsRoot);
  return true;
}
/** Re-read pinned originals and replay mappings, rather than trusting receipts. */
export function verifyCapabilitySources(root, evidence, tasks) {
  requireData(object(evidence) && evidence.schemaVersion === 1 && Array.isArray(evidence.sources), 'capability_source_evidence_required');
  const entries = [], byTask = new Map();
  for (const source of evidence.sources) {
    requireData(capabilitySourceIds.includes(source.dataset) && Array.isArray(source.originalFiles)
      && source.originalFiles.length > 0 && object(source.license) && nonempty(source.attribution), 'capability_source_evidence_invalid');
    const files = new Map();
    capabilityRelativePath(source.prefix);
    requireData(source.prefix.startsWith('sources/'), 'capability_source_evidence_path_invalid');
    for (const file of source.originalFiles) {
      requireData(digest(file.sha256) && formats.has(file.format) && roles.has(file.role), 'capability_source_file_pin_invalid');
      const bytes = readFileSync(safeFile(root, `${source.prefix}/original/${capabilityRelativePath(file.path)}`));
      requireData(!files.has(file.path) && sha256(bytes) === file.sha256, 'capability_source_hash_mismatch');
      files.set(file.path, { ...file, bytes, value: parse(bytes, file.format) });
    }
    requireData(localSourceRevision([...files.values()]) === source.contentRevision, 'capability_source_revision_mismatch');
    requireData(source.revision === source.contentRevision || /^[a-f0-9]{40}$/u.test(source.revision)
      || source.dataset === 'qasper' && source.revision === qasperSourceContract().source.version, 'capability_source_revision_unpinned');
    if (source.dataset !== 'qasper') {
      if (/^[a-f0-9]{40}$/u.test(source.revision)) {
        if (source.origin?.kind === 'locked-public-snapshot') {
          const locked = lockedOriginals(source.dataset, source.revision, source.license.id, files);
          requireData(locked && source.gitProof === undefined && hash(source.origin) === hash(lockedOrigin(locked)),
            'capability_locked_source_origin_changed');
        } else {
          requireData(source.origin?.kind === 'local-git-snapshot', 'capability_source_origin_invalid');
          verifyGitProof(source, files);
        }
      } else requireData(source.origin?.kind === 'local-content-snapshot' && source.gitProof === undefined,
        'capability_source_origin_invalid');
      const license = files.get(source.license.file);
      requireData(license?.role === 'license' && license.sha256 === source.license.sha256, 'capability_source_license_pin_invalid');
      verifyLicense(source.license.id, license.value);
    }
    const mappingBytes = readFileSync(safeFile(root, source.mapping.path));
    requireData(source.mapping.path === `${source.prefix}/mapping.json` && sha256(mappingBytes) === source.mapping.sha256,
      'capability_source_mapping_changed');
    const mappings = parse(mappingBytes, 'json');
    requireData(Array.isArray(mappings) && mappings.length === source.originals.length, 'capability_source_mapping_incomplete');
    const upstreamVerified = lockedUpstream(source, files, join(root, source.prefix, 'original'));
    if (source.dataset === 'qasper') requireData(upstreamVerified, 'capability_qasper_original_qualification_unverified');
    requireData(hash(scienceQualification({ ...source, files: source.originalFiles })) === hash(source.qualification),
      'capability_science_qualification_forged');
    for (const [index, mapping] of mappings.entries()) {
      const entry = mappedTask(source, mapping, files);
      entry.original.mappingIndex = index;
      entry.original.taskId = entry.task.id;
      entry.saved = source.originals[index];
      requireData(!byTask.has(entry.task.id), 'capability_duplicate_original_identity');
      byTask.set(entry.task.id, { source, upstreamVerified, clusterKeys: entry.original.clusterKeys,
        scientificQuality: source.qualification?.scientificQuality ?? null });
      entries.push(entry);
    }
  }
  assignCapabilityClusters(entries);
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  for (const entry of entries) {
    entry.original.taskHash = hash(entry.task);
    requireData(hash(entry.original) === hash(entry.saved), 'capability_source_derivation_changed');
    const actual = tasksById.get(entry.task.id);
    // unsupported is recomputed by the task validator and cannot grant support.
    const normalized = actual && { ...actual, ...(entry.task.unsupported ? { unsupported: entry.task.unsupported } : {}) };
    if (!entry.task.unsupported && normalized) delete normalized.unsupported;
    requireData(actual && hash(normalized) === hash(entry.task), 'capability_task_not_derived_from_original');
  }
  requireData(tasks.filter(task => task.source.dataset !== 'roc-engineering-fixture').length === entries.length,
    'capability_source_task_inventory_mismatch');
  return byTask;
}
