#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {cpus, release, totalmem} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const objectHash = value => sha256(JSON.stringify(canonical(value)));
const displayPath = path => relative(root, realpathSync(path)) || '.';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function command(command, args) {
  return execFileSync(command, args, {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: {...process.env, LC_ALL: 'C'}, stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

function fileDigest(path) {
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd, {bigint: true});
    assert.ok(before.isFile(), 'inventory_regular_file_required');
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, count)); bytes += count;
    }
    const after = fstatSync(fd, {bigint: true});
    assert.ok(before.size === after.size && before.mtimeNs === after.mtimeNs
      && BigInt(bytes) === before.size, 'inventory_file_changed');
    return {bytes, sha256: digest.digest('hex')};
  } finally { closeSync(fd); }
}

function diskKiB(paths) {
  const lines = command('/usr/bin/du', ['-skc', ...paths]).split('\n');
  const total = lines.at(-1).match(/^(\d+)\s+total$/u);
  assert.ok(total, 'inventory_disk_usage_invalid');
  return Number(total[1]);
}

function fileTree(path) {
  const files = [];
  let symlinkCount = 0, directoryCount = 0;
  function visit(current) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) { symlinkCount++; return; }
    if (stat.isDirectory()) {
      directoryCount++;
      for (const name of readdirSync(current).sort()) visit(join(current, name));
    } else {
      assert.ok(stat.isFile(), 'inventory_special_file_rejected');
      files.push({path: relative(path, current) || '.', bytes: stat.size});
    }
  }
  visit(path);
  return {path: displayPath(path), logicalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    diskKiB: diskKiB([path]), fileCount: files.length, symlinkCount, directoryCount, files};
}

function treeSummary(path) {
  const {files, ...summary} = fileTree(path);
  return summary;
}

function lockedFile(rootPath, name) {
  assert.ok(lstatSync(rootPath).isDirectory() && !lstatSync(rootPath).isSymbolicLink(),
    'inventory_locked_root_invalid');
  assert.ok(typeof name === 'string' && !isAbsolute(name) && !/[\\\r\n]/u.test(name)
    && name.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
  'inventory_locked_path_invalid');
  let current = rootPath;
  for (const part of name.split('/')) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'inventory_locked_symlink_rejected');
  }
  const rel = relative(realpathSync(rootPath), realpathSync(current));
  assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'inventory_locked_path_outside_root');
  return current;
}

function modelsInventory() {
  const lockPath = join(root, 'resources/research-models/models.lock.json');
  const modelRoot = join(root, '.runtime/research-models'), lock = readJson(lockPath);
  const files = lock.assets.map(asset => {
    const actual = fileDigest(lockedFile(modelRoot, asset.file));
    assert.equal(actual.bytes, asset.bytes, `inventory_model_size_mismatch:${asset.id}`);
    assert.equal(actual.sha256, asset.sha256, `inventory_model_hash_mismatch:${asset.id}`);
    return {id: asset.id, path: asset.file, sourceRevision: asset.sourceRevision, ...actual};
  });
  assert.equal(new Set(files.map(file => file.id)).size, files.length, 'inventory_model_duplicate_id');
  const byId = new Map(files.map(file => [file.id, file]));
  const packs = Object.fromEntries(Object.entries(lock.packs).map(([name, pack]) => {
    const selected = pack.assetIds.map(id => { assert.ok(byId.has(id)); return byId.get(id); });
    const logicalBytes = selected.reduce((sum, file) => sum + file.bytes, 0);
    assert.equal(logicalBytes, pack.bytes, `inventory_model_pack_size_mismatch:${name}`);
    return [name, {assetIds: pack.assetIds, logicalBytes,
      diskKiB: diskKiB(selected.map(file => join(modelRoot, file.path)))}];
  }));
  return {root: displayPath(modelRoot), lock: {path: displayPath(lockPath), ...fileDigest(lockPath)},
    engine: lock.engine, files, packs, diskKiB: diskKiB([modelRoot]), verified: true};
}

function sourcesInventory() {
  const lockPath = join(root, 'evaluation/corpora/scientific-rag/public-sources.lock.json');
  const sourceRoot = join(root, 'evaluation/local/sources/scientific-public'), lock = readJson(lockPath);
  const files = lock.files.map(pin => {
    const actual = fileDigest(lockedFile(sourceRoot, pin.path));
    assert.equal(actual.bytes, pin.bytes, `inventory_source_size_mismatch:${pin.path}`);
    assert.equal(actual.sha256, pin.sha256, `inventory_source_hash_mismatch:${pin.path}`);
    return {path: pin.path, ...actual};
  });
  assert.equal(new Set(files.map(file => file.path)).size, files.length, 'inventory_source_duplicate_path');
  return {root: displayPath(sourceRoot), lock: {path: displayPath(lockPath), ...fileDigest(lockPath)},
    sourceLockHash: objectHash(lock), verified: true, fileCount: files.length,
    pdfCount: files.filter(file => file.path.endsWith('.pdf')).length,
    imageCount: files.filter(file => file.path.startsWith('omnidocbench/images/')).length,
    files, scientificBaselineReady: false};
}

/** Read one packed entry without extracting or loading any packaged code. */
function asarMainDigest(archive) {
  const fd = openSync(archive, 'r');
  try {
    const before = fstatSync(fd, {bigint: true}), prefix = Buffer.alloc(8);
    assert.equal(readSync(fd, prefix, 0, 8, 0), 8, 'inventory_asar_header_missing');
    assert.equal(prefix.readUInt32LE(0), 4, 'inventory_asar_pickle_invalid');
    const headerSize = prefix.readUInt32LE(4);
    assert.ok(headerSize >= 8 && headerSize <= 64 * 1024 * 1024, 'inventory_asar_header_size_invalid');
    const headerBytes = Buffer.alloc(headerSize);
    assert.equal(readSync(fd, headerBytes, 0, headerSize, 8), headerSize, 'inventory_asar_header_truncated');
    const jsonBytes = headerBytes.readUInt32LE(4);
    assert.ok(jsonBytes > 0 && jsonBytes <= headerSize - 8, 'inventory_asar_json_size_invalid');
    const header = JSON.parse(headerBytes.subarray(8, 8 + jsonBytes).toString('utf8'));
    const entry = header.files?.dist?.files?.main?.files?.['index.js'];
    assert.ok(entry && !entry.unpacked && !entry.link && Number.isSafeInteger(entry.size)
      && entry.size > 0 && typeof entry.offset === 'string' && /^\d+$/u.test(entry.offset),
    'inventory_asar_main_entry_invalid');
    const offset = 8 + headerSize + Number(entry.offset);
    assert.ok(Number.isSafeInteger(offset) && BigInt(offset + entry.size) <= before.size,
      'inventory_asar_main_range_invalid');
    const bytes = Buffer.alloc(entry.size);
    assert.equal(readSync(fd, bytes, 0, bytes.length, offset), bytes.length, 'inventory_asar_main_truncated');
    const after = fstatSync(fd, {bigint: true});
    assert.ok(before.size === after.size && before.mtimeNs === after.mtimeNs, 'inventory_asar_changed');
    return {entry: 'dist/main/index.js', bytes: bytes.length, sha256: sha256(bytes)};
  } finally { closeSync(fd); }
}

function appInventory(appPath) {
  const appRoot = realpathSync(appPath);
  assert.ok(lstatSync(appRoot).isDirectory(), 'inventory_app_directory_required');
  const resources = join(appRoot, 'Contents/Resources'), archive = join(resources, 'app.asar');
  const {files, ...summary} = fileTree(appRoot);
  const nativeFiles = files.filter(file => /\.(?:node|dylib)$/u.test(file.path))
    .map(file => ({...file, ...fileDigest(join(appRoot, file.path))}));
  const packagedMain = asarMainDigest(archive), currentMainPath = join(root, 'dist/main/index.js');
  const currentMain = existsSync(currentMainPath) ? fileDigest(currentMainPath) : null;
  return {...summary, asar: {...treeSummary(archive), ...fileDigest(archive)},
    asarUnpacked: treeSummary(join(resources, 'app.asar.unpacked')),
    researchToolchain: treeSummary(join(resources, 'research-toolchain')),
    native: {fileCount: nativeFiles.length, logicalBytes: nativeFiles.reduce((sum, file) => sum + file.bytes, 0),
      manifestSha256: objectHash(nativeFiles), files: nativeFiles},
    buildSourceMatch: {packagedMain, currentMain,
      mainBundleBytesEqual: currentMain === null ? null : currentMain.sha256 === packagedMain.sha256,
      sourceCommitVerified: false}};
}

function main(args) {
  assert.ok(args.length >= 1 && args.length <= 2 && args[0].endsWith('.json'),
    'Usage: node scripts/research-toolchain-inventory.mjs OUTPUT_JSON [APP_PATH]');
  const output = resolve(args[0]);
  assert.ok(!existsSync(output), 'inventory_output_exists');
  const packagePath = join(root, 'package.json'), lockPath = join(root, 'pnpm-lock.yaml');
  const pkg = readJson(packagePath);
  const report = {schemaVersion: 1, kind: 'research-toolchain-p0-inventory', measuredAt: new Date().toISOString(),
    source: {head: command('git', ['rev-parse', 'HEAD']), main: command('git', ['rev-parse', 'main']),
      trackedDirty: command('git', ['status', '--porcelain', '--untracked-files=no']) !== '',
      package: {path: 'package.json', ...fileDigest(packagePath)},
      lock: {path: 'pnpm-lock.yaml', ...fileDigest(lockPath)},
      script: {path: 'scripts/research-toolchain-inventory.mjs', ...fileDigest(fileURLToPath(import.meta.url))}},
    versions: {application: pkg.version, node: process.version, packageManager: pkg.packageManager,
      pnpm: command('pnpm', ['--version']), uv: command('uv', ['--version']),
      python: JSON.parse(command('python3', ['-I', '-S', '-c',
        'import json,platform,sys;print(json.dumps({"version":platform.python_version(),"implementation":sys.implementation.name,"architecture":platform.machine()}))'])),
      dependencies: pkg.dependencies,
      optionalDependencies: pkg.optionalDependencies, devDependencies: pkg.devDependencies},
    host: {platform: process.platform, arch: process.arch, osRelease: release(),
      macOS: command('/usr/bin/sw_vers', ['-productVersion']), chip: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length, totalMemoryBytes: totalmem()},
    models: modelsInventory(), publicSources: sourcesInventory(),
    app: appInventory(resolve(args[1] ?? join(root, 'release/mac-arm64/Roc.app'))),
    limitations: [
      'Existing app is not attributed to HEAD; matching one main bundle proves only those bytes are equal.',
      'Logical bytes sum regular files without following symlinks. du -skc reports allocated KiB and may share filesystem extents.',
      'Model pack disk totals cover listed files; complete includes compact assets and packs must not be added together.',
      'Native inventory includes regular .node/.dylib files, excluding symlink aliases; it is not every executable binary.',
      'Source hashes verify fixed public inputs; this inventory does not score parsing or establish complete scientific gold.',
      'This target distributes an app directory. Installer ZIP/DMG size is not measured.'
    ]};
  mkdirSync(dirname(output), {recursive: true, mode: 0o700});
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({output: relative(root, output), models: report.models.files.length,
    sources: report.publicSources.fileCount, appLogicalBytes: report.app.logicalBytes,
    sourceCommitVerified: false}));
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
