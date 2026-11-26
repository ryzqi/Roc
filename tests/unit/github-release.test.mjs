import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createReleasePlan } from '../../scripts/release-mac.mjs';
import { projectRoot } from '../../scripts/lib/project-paths.mjs';

const macOnly = { skip: process.platform !== 'darwin' || process.arch !== 'arm64' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const fakeGh = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const path = process.env.ROC_RELEASE_TEST_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
appendFileSync(process.env.ROC_RELEASE_TEST_LOG, JSON.stringify(args) + '\\n');
const value = (flag) => args[args.indexOf(flag) + 1];
function fail(message) { console.error(message); process.exit(1); }
function save() { writeFileSync(path, JSON.stringify(state)); }
if (args[0] === 'api') {
  if (state.apiError) fail('gh: injected authentication failure (HTTP 401)');
  const endpoint = args[1];
  const ref = decodeURIComponent(endpoint.split('/').pop());
  if (endpoint.includes('/commits/')) {
    if (ref === state.commit) console.log(JSON.stringify({ sha: state.commit }));
    else if (ref === state.tag && state.tagCommit) console.log(JSON.stringify({ sha: state.tagCommit }));
    else fail('gh: Not Found (HTTP 404)');
  } else if (endpoint.includes('/releases/tags/') && state.release?.tag_name === ref) {
    console.log(JSON.stringify(state.release));
  } else fail('gh: Not Found (HTTP 404)');
} else if (args[0] === 'release' && args[1] === 'create') {
  if (state.release) fail('gh: release already exists (HTTP 422)');
  state.tag = args[2];
  state.tagCommit = value('--target');
  state.release = {
    tag_name: state.tag, draft: true, prerelease: args.includes('--prerelease=true'),
    body: readFileSync(value('--notes-file'), 'utf8'), assets: [],
    html_url: 'https://github.com/release-test/Roc/releases/tag/' + state.tag
  };
  save();
} else if (args[0] === 'release' && args[1] === 'upload') {
  if (!state.release?.draft) fail('gh: immutable published release (HTTP 409)');
  const name = basename(args[3]);
  if (state.failUploadSuffix && name.endsWith(state.failUploadSuffix)) {
    fail('gh: injected upload failure (HTTP 503)');
  }
  if (state.release.assets.some(asset => asset.name === name)) fail('gh: asset already exists (HTTP 422)');
  const bytes = readFileSync(args[3]);
  state.release.assets.push({
    name, size: bytes.length, state: 'uploaded',
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  });
  save();
} else if (args[0] === 'release' && args[1] === 'edit') {
  if (!state.release?.draft) fail('gh: immutable published release (HTTP 409)');
  if (args.includes('--notes-file')) state.release.body = readFileSync(value('--notes-file'), 'utf8');
  if (args.includes('--draft=false')) {
    state.release.draft = false;
    state.release.prerelease = args.includes('--prerelease=true');
    state.release.latest = args.includes('--latest=true');
  }
  save();
} else fail('Unexpected gh command: ' + args.join(' '));
`;

const fakePnpm = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.env.ROC_RELEASE_TEST_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
state.packageRuns++;
writeFileSync(path, JSON.stringify(state));
if (process.argv.slice(2).join(' ') !== 'package:mac') throw new Error('Unexpected pnpm command');
if (state.packageError) { console.error('injected packaging failure'); process.exit(1); }
console.log('Fixture package:mac completed.');
`;

function checked(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result.stdout.trim();
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'roc-github-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  const bin = join(directory, 'bin');
  const statePath = join(directory, 'state.json');
  const logPath = join(directory, 'gh.jsonl');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(projectRoot, 'scripts', 'release-mac.mjs'), join(root, 'scripts', 'release-mac.mjs'));
  copyFileSync(join(projectRoot, 'scripts', 'lib', 'project-paths.mjs'), join(root, 'scripts', 'lib', 'project-paths.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'roc', version: '0.1.0', type: 'module' }));
  writeFileSync(join(root, '.gitignore'), 'release/\n');
  const app = join(root, 'release', 'mac-arm64', 'Roc.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'));
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.roc.release.fixture</string>
<key>CFBundleName</key><string>Roc</string>
<key>CFBundleExecutable</key><string>Roc</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>0.1.0</string>
</dict></plist>`);
  copyFileSync('/usr/bin/true', join(app, 'Contents', 'MacOS', 'Roc'));
  chmodSync(join(app, 'Contents', 'MacOS', 'Roc'), 0o755);
  writeFileSync(join(app, 'Contents', 'Resources', 'probe.txt'), 'Roc archive fixture\n');
  symlinkSync('probe.txt', join(app, 'Contents', 'Resources', 'probe-link.txt'));
  checked('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
  checked('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  checked('git', ['add', '.'], { cwd: root });
  checked('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Roc Release Test',
    '-c', 'user.email=roc-release@example.invalid', 'commit', '--quiet', '-m', 'Release fixture'
  ], { cwd: root });
  const commit = checked('git', ['rev-parse', 'HEAD'], { cwd: root });
  writeFileSync(statePath, JSON.stringify({ commit, packageRuns: 0, release: null }));
  writeFileSync(logPath, '');
  writeFileSync(join(bin, 'gh'), fakeGh, { mode: 0o755 });
  writeFileSync(join(bin, 'pnpm'), fakePnpm, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    GH_REPO: 'release-test/Roc', GITHUB_ACTIONS: 'false',
    ROC_RELEASE_TEST_STATE: statePath, ROC_RELEASE_TEST_LOG: logPath
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return {
    root, app, commit, directory, env,
    run: (...args) => spawnSync(process.execPath, [join(root, 'scripts', 'release-mac.mjs'), ...args], { cwd: root, env, encoding: 'utf8' }),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    update: (patch) => writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), ...patch })),
    calls: () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    clearCalls: () => writeFileSync(logPath, '')
  };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
}

test('version labels keep snapshots and tagged beta releases as prereleases', () => {
  const base = { commit: 'a'.repeat(40), repository: 'release-test/Roc', version: '0.1.0-beta.1' };
  assert.equal(createReleasePlan(base).tag, `v0.1.0-beta.1.build.${'a'.repeat(12)}`);
  assert.equal(createReleasePlan({ ...base, tag: 'v0.1.0-beta.1' }).prerelease, true);
  assert.throws(() => createReleasePlan({ ...base, tag: 'v0.2.0' }), /must match/);
});

test('publishes a verified ZIP and preserves application executable mode and symlinks', macOnly, (t) => {
  const f = fixture(t);
  const result = success(f.run());
  const state = f.state();
  assert.equal(state.release.draft, false);
  assert.equal(state.release.prerelease, true);
  assert.equal(state.release.latest, false);
  assert.match(state.release.body, /development \(ad-hoc\)/u);
  assert.match(state.release.body, /not Apple notarized/u);
  assert.equal(state.tagCommit, f.commit);
  assert.equal(state.release.assets.length, 3);
  const zipAsset = state.release.assets.find((asset) => asset.name.endsWith('.zip'));
  const archivePath = join(f.root, 'release', zipAsset.name);
  const bytes = readFileSync(archivePath);
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(zipAsset.digest, `sha256:${sha256(bytes)}`);
  const manifest = JSON.parse(readFileSync(`${archivePath}.release.json`, 'utf8'));
  assert.equal(manifest.commit, f.commit);
  assert.equal(manifest.sourceDirty, false);
  assert.equal(manifest.architecture, 'arm64');
  assert.equal(manifest.asset.size, bytes.length);
  assert.equal(readFileSync(`${archivePath}.sha256`, 'utf8'), `${sha256(bytes)}  ${zipAsset.name}\n`);
  const extracted = join(f.directory, 'extracted');
  checked('/usr/bin/ditto', ['-x', '-k', archivePath, extracted]);
  const executable = join(extracted, 'Roc.app', 'Contents', 'MacOS', 'Roc');
  assert.equal(statSync(executable).mode & 0o111, 0o111);
  assert.equal(readlinkSync(join(extracted, 'Roc.app', 'Contents', 'Resources', 'probe-link.txt')), 'probe.txt');
  checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(extracted, 'Roc.app')]);
  const writes = f.calls().filter((args) => args[0] === 'release');
  assert.equal(writes[0][1], 'create');
  assert.ok(writes[0].includes('--draft'));
  assert.equal(writes.at(-1)[1], 'edit');
  assert.ok(writes.at(-1).includes('--draft=false'));
  assert.ok(writes.every((args) => !args.includes('--clobber')));
});

test('repeated publication reuses a complete immutable release without building or writing', macOnly, (t) => {
  const f = fixture(t);
  success(f.run());
  f.clearCalls();
  const result = success(f.run());
  assert.equal(result.reused, true);
  assert.equal(f.state().packageRuns, 1);
  assert.ok(f.calls().every((args) => args[0] === 'api'));
});

test('failed metadata upload keeps a draft and retry resumes without rebuilding the ZIP', macOnly, (t) => {
  const f = fixture(t);
  f.update({ failUploadSuffix: '.release.json' });
  const failed = f.run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /upload failure/);
  assert.equal(f.state().release.draft, true);
  assert.equal(f.state().release.assets.length, 2);
  const zipDigest = f.state().release.assets[0].digest;
  f.update({ failUploadSuffix: null });
  f.clearCalls();
  success(f.run());
  assert.equal(f.state().release.draft, false);
  assert.equal(f.state().packageRuns, 1);
  assert.equal(f.state().release.assets[0].digest, zipDigest);
  assert.equal(f.calls().filter((args) => args[1] === 'upload').length, 1);
});

test('failed ZIP upload leaves an empty draft that can rebuild and retry', macOnly, (t) => {
  const f = fixture(t);
  f.update({ failUploadSuffix: '.zip' });
  assert.notEqual(f.run().status, 0);
  assert.equal(f.state().release.draft, true);
  assert.equal(f.state().release.assets.length, 0);
  f.update({ failUploadSuffix: null });
  success(f.run());
  assert.equal(f.state().release.draft, false);
  assert.equal(f.state().packageRuns, 2);
});

test('authentication failure and remote tag conflict stop before building or writing', macOnly, (t) => {
  const f = fixture(t);
  f.update({ apiError: true });
  assert.match(f.run().stderr, /HTTP 401/);
  assert.equal(f.state().packageRuns, 0);
  assert.equal(f.state().release, null);
  assert.ok(f.calls().every((args) => args[0] === 'api'));
  f.update({ apiError: false, tag: 'v0.1.0', tagCommit: 'b'.repeat(40) });
  assert.match(f.run('--tag', 'v0.1.0').stderr, /different commit/);
  assert.equal(f.state().packageRuns, 0);
  assert.equal(f.state().release, null);
});

test('version mismatch and uncommitted source changes stop before accessing GitHub', macOnly, (t) => {
  const f = fixture(t);
  assert.match(f.run('--tag', 'v0.2.0').stderr, /must match/);
  assert.equal(f.calls().length, 0);
  appendFileSync(join(f.root, 'package.json'), '\n');
  assert.match(f.run().stderr, /Commit local changes/);
  assert.equal(f.calls().length, 0);
  assert.equal(f.state().packageRuns, 0);
});

test('dry-run archives dirty source and never invokes GitHub', macOnly, (t) => {
  const f = fixture(t);
  appendFileSync(join(f.root, 'package.json'), '\n');
  const result = success(f.run('--dry-run'));
  assert.equal(result.dryRun, true);
  assert.equal(result.sourceDirty, true);
  assert.equal(result.sha256, sha256(readFileSync(result.archivePath)));
  assert.equal(f.calls().length, 0);
  assert.equal(f.state().release, null);
});

test('a version tag in Actions produces a stable release and mismatched checkout fails', macOnly, (t) => {
  const f = fixture(t);
  f.env.GITHUB_ACTIONS = 'true';
  f.env.GITHUB_REF_TYPE = 'tag';
  f.env.GITHUB_REF_NAME = 'v0.1.0';
  f.env.GITHUB_SHA = 'b'.repeat(40);
  assert.match(f.run().stderr, /does not match/);
  assert.equal(f.calls().length, 0);
  f.env.GITHUB_SHA = f.commit;
  const result = success(f.run());
  assert.equal(result.tag, 'v0.1.0');
  assert.equal(f.state().release.prerelease, false);
  assert.equal(f.state().release.latest, true);
});

test('corrupted existing assets and packaging failures never publish an incomplete release', macOnly, (t) => {
  const f = fixture(t);
  f.update({ packageError: true });
  assert.match(f.run().stderr, /exit 1/);
  assert.equal(f.state().release, null);
  f.update({ packageError: false, failUploadSuffix: '.release.json' });
  assert.notEqual(f.run().status, 0);
  const state = f.state();
  state.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  f.update({ release: state.release, failUploadSuffix: null });
  f.clearCalls();
  assert.match(f.run().stderr, /different SHA-256/);
  assert.equal(f.state().release.draft, true);
  assert.ok(f.calls().every((args) => args[0] === 'api'));
});
