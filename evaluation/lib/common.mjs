import { createHash, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = resolve(import.meta.dirname, '../..');
export const EVAL_ROOT = join(ROOT, 'evaluation');
export const CACHE = join(EVAL_ROOT, 'datasets');
export const RUNS = join(EVAL_ROOT, 'runs');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => sha256(JSON.stringify(canonical(value)));
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export function directory(parent, prefix) {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, `${prefix}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(path, { mode: 0o700 });
  return path;
}
export function contained(root, path) {
  const target = resolve(root, path);
  const rel = relative(realpathSync(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path_outside_root');
  return target;
}
export function fileInventory(root) {
  const entries = [];
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('artifact_link_or_special_file');
      if (stat.isDirectory()) visit(path);
      else entries.push({ path: relative(root, path), bytes: stat.size, sha256: sha256(readFileSync(path)) });
    }
  }
  visit(root);
  return entries;
}
// Native isolation fixtures intentionally contain links. Archive their definitions as data,
// never as live links or by reading their targets. Other artifact inventories remain strict.
export function snapshotNativeEvidence(source, target) {
  const links = [];
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false, filter(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { links.push({ path: relative(source, path), target: readlinkSync(path) }); return false; }
    if (!stat.isFile() && !stat.isDirectory()) fail('infrastructure', 'native_special_file');
    return true;
  } });
  return links;
}
export function sourceIdentity() {
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts', 'resources', 'evaluation', 'package.json', 'pnpm-lock.yaml']).split('\n').filter(Boolean);
  const files = [...new Set(paths)].sort().map(path => ({ path, sha256: existsSync(join(ROOT, path)) ? sha256(readFileSync(join(ROOT, path))) : null }));
  return { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--', 'src', 'scripts', 'resources', 'evaluation', 'package.json', 'pnpm-lock.yaml']) !== '',
    sourceHash: hash(files), files, lockfileHash: sha256(readFileSync(join(ROOT, 'pnpm-lock.yaml'))),
    node: process.version, platform: process.platform, arch: process.arch };
}
export function journal(path, { resume = false } = {}) {
  let sequence = 0;
  if (resume) {
    const stat = lstatSync(path), text = readFileSync(path, 'utf8');
    if (!stat.isFile() || stat.isSymbolicLink() || text && !text.endsWith('\n')) fail('state', 'run_journal_invalid');
    const previous = text.trim() ? text.trimEnd().split('\n').map(JSON.parse) : [];
    if (previous.some((event, index) => event.sequence !== index + 1)) fail('state', 'run_journal_sequence_invalid');
    sequence = previous.length;
  }
  const fd = openSync(path, resume ? 'a' : 'wx', 0o600);
  return { append(event) {
    const entry = { ...event, sequence: ++sequence, at: new Date().toISOString() };
    writeSync(fd, JSON.stringify(entry) + '\n'); fsyncSync(fd);
    return entry;
  },
    close() { closeSync(fd); } };
}
export class EvaluationError extends Error {
  constructor(failureClass, code) { super(code); this.failureClass = failureClass; }
}
export function fail(failureClass, code) { throw new EvaluationError(failureClass, code); }
