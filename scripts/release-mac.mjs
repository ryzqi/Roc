#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { projectRoot } from './lib/project-paths.mjs';

const METADATA_START = '<!-- roc-mac-release\n';
const METADATA_END = '\n-->';

function command(commandName, args, { cwd, env, inherit = false }) {
  const result = spawnSync(commandName, args, {
    cwd, env, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 8 * 1024 * 1024
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    const error = new Error(`${commandName} ${args.join(' ')} failed: ${detail}`);
    error.stderr = result.stderr ?? '';
    throw error;
  }
  return result.stdout?.trim() ?? '';
}

function repositoryFromOrigin(origin) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin);
  if (match === null) throw new Error('Set --repo OWNER/REPO or use a github.com origin remote.');
  return match[1];
}

export function createReleasePlan({ version, commit, repository, tag, sourceDirty = false }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('package.json must contain a release version such as 0.1.0 or 0.1.0-beta.1.');
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('A full Git commit SHA is required.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('The release repository must be OWNER/REPO.');
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} must match package.json version: v${version}.`);
  }
  const snapshotVersion = `${version}${version.includes('-') ? '.' : '-'}build.${commit.slice(0, 12)}`;
  const releaseTag = tag ?? `v${snapshotVersion}`;
  return {
    repository, commit, version, tag: releaseTag, sourceDirty,
    prerelease: tag === undefined || version.includes('-'),
    assetName: `Roc-${releaseTag.slice(1)}-mac-arm64.zip`
  };
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function textSha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function checksumText(manifest) {
  return `${manifest.asset.sha256}  ${manifest.asset.name}\n`;
}

function releaseNotes(manifest) {
  return [
    `Roc ${manifest.version} for macOS Apple Silicon (arm64).`,
    '',
    `Commit: \`${manifest.commit}\`.`,
    '',
    `Download \`${manifest.asset.name}\`, unzip it, and move Roc.app to Applications.`,
    '',
    `SHA-256: \`${manifest.asset.sha256}\`.`,
    '',
    `${METADATA_START}${JSON.stringify(manifest)}${METADATA_END}`,
    ''
  ].join('\n');
}

function releaseManifest(release, plan) {
  const start = release.body?.indexOf(METADATA_START) ?? -1;
  const end = start < 0 ? -1 : release.body.indexOf(METADATA_END, start);
  if (start < 0 || end < 0) throw new Error(`Release ${plan.tag} has no Roc build metadata; inspect it before retrying.`);
  let manifest;
  try {
    manifest = JSON.parse(release.body.slice(start + METADATA_START.length, end));
  } catch {
    throw new Error(`Release ${plan.tag} contains invalid Roc build metadata.`);
  }
  if (
    manifest?.schemaVersion !== 1 || manifest.repository !== plan.repository || manifest.commit !== plan.commit
    || manifest.version !== plan.version || manifest.tag !== plan.tag || manifest.sourceDirty !== false
    || manifest.platform !== 'darwin' || manifest.architecture !== 'arm64'
    || manifest.asset?.name !== plan.assetName || !/^[0-9a-f]{64}$/.test(manifest.asset.sha256)
    || !Number.isSafeInteger(manifest.asset.size) || manifest.asset.size <= 0
  ) {
    throw new Error(`Release ${plan.tag} belongs to a different build; existing assets will not be replaced.`);
  }
  return manifest;
}

function expectedAssets(manifest, directory) {
  const metadata = manifestText(manifest);
  const checksum = checksumText(manifest);
  return [
    { name: manifest.asset.name, path: join(directory, manifest.asset.name), ...manifest.asset },
    {
      name: `${manifest.asset.name}.sha256`, path: join(directory, `${manifest.asset.name}.sha256`),
      sha256: textSha256(checksum), size: Buffer.byteLength(checksum)
    },
    {
      name: `${manifest.asset.name}.release.json`, path: join(directory, `${manifest.asset.name}.release.json`),
      sha256: textSha256(metadata), size: Buffer.byteLength(metadata)
    }
  ];
}

function matchingAsset(release, expected) {
  const asset = release.assets.find((entry) => entry.name === expected.name);
  if (asset === undefined) return false;
  if (asset.state !== 'uploaded' || asset.size !== expected.size || asset.digest !== `sha256:${expected.sha256}`) {
    throw new Error(`Release asset ${expected.name} is incomplete or has a different SHA-256; inspect the draft before retrying.`);
  }
  return true;
}

function writeMetadata(directory, manifest) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${manifest.asset.name}.sha256`), checksumText(manifest));
  writeFileSync(join(directory, `${manifest.asset.name}.release.json`), manifestText(manifest));
  const notesPath = join(directory, `${manifest.asset.name}.release-notes.md`);
  writeFileSync(notesPath, releaseNotes(manifest));
  return notesPath;
}

export async function archiveMacApp({ appPath, directory, plan, run = command, env = process.env }) {
  const options = { cwd: projectRoot, env };
  const version = run('/usr/bin/plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw', join(appPath, 'Contents', 'Info.plist')
  ], options);
  if (version !== plan.version) throw new Error(`Roc.app version ${version} does not match package.json ${plan.version}.`);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], options);
  mkdirSync(directory, { recursive: true });
  const archivePath = join(directory, plan.assetName);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archivePath], options);
  const manifest = {
    schemaVersion: 1, repository: plan.repository, tag: plan.tag, version: plan.version,
    commit: plan.commit, sourceDirty: plan.sourceDirty, platform: 'darwin', architecture: 'arm64',
    asset: { name: plan.assetName, sha256: await fileSha256(archivePath), size: statSync(archivePath).size }
  };
  writeMetadata(directory, manifest);
  return manifest;
}

export async function releaseMac({ root = projectRoot, env = process.env, tag, repository, dryRun = false, planOnly = false } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('release:mac requires an arm64 macOS host.');
  }
  const options = { cwd: root, env };
  const run = (name, args, extra = {}) => command(name, args, { ...options, ...extra });
  const commit = run('git', ['rev-parse', 'HEAD']);
  if (env.GITHUB_ACTIONS === 'true' && commit !== env.GITHUB_SHA) {
    throw new Error('Checked-out HEAD does not match the GitHub Actions commit.');
  }
  const sourceDirty = run('git', ['status', '--porcelain=v1', '--untracked-files=normal']) !== '';
  const packageInfo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const plan = createReleasePlan({
    version: packageInfo.version, commit, sourceDirty,
    repository: repository ?? env.GH_REPO ?? env.GITHUB_REPOSITORY ?? repositoryFromOrigin(run('git', ['remote', 'get-url', 'origin'])),
    tag: tag ?? (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : undefined)
  });
  if (planOnly) return plan;
  if (!dryRun && sourceDirty) throw new Error('Commit local changes and push this commit before publishing a release.');

  const gh = (args) => run('gh', [...args, '--repo', plan.repository]);
  const api = (path) => JSON.parse(run('gh', ['api', `repos/${plan.repository}/${path}`]));
  const lookup = (path) => {
    try {
      return api(path);
    } catch (error) {
      if (/\(HTTP 404\)/.test(error.stderr ?? '')) return null;
      throw error;
    }
  };
  const directory = join(root, 'release');
  let release = null;
  let manifest;
  if (!dryRun) {
    const remoteCommit = lookup(`commits/${commit}`);
    if (remoteCommit?.sha !== commit) throw new Error('The current commit is not on GitHub. Push it before publishing a release.');
    const remoteTag = lookup(`commits/${encodeURIComponent(plan.tag)}`);
    if (remoteTag !== null && remoteTag.sha !== commit) throw new Error(`GitHub tag ${plan.tag} points to a different commit.`);
    release = lookup(`releases/tags/${encodeURIComponent(plan.tag)}`);
    if (release !== null) {
      manifest = releaseManifest(release, plan);
      const assets = expectedAssets(manifest, directory);
      if (matchingAsset(release, assets[0])) {
        if (!release.draft) {
          if (!assets.every((asset) => matchingAsset(release, asset)) || release.prerelease !== plan.prerelease) {
            throw new Error(`Published release ${plan.tag} is incomplete or has the wrong release type.`);
          }
          return { tag: plan.tag, url: release.html_url, sha256: manifest.asset.sha256, reused: true };
        }
      } else {
        if (!release.draft || release.assets.length !== 0) {
          throw new Error(`Release ${plan.tag} has no verified ZIP; inspect it before retrying.`);
        }
        manifest = undefined;
      }
    }
  }
  if (manifest === undefined) {
    run('pnpm', ['package:mac'], { inherit: true });
    if (run('git', ['rev-parse', 'HEAD']) !== commit || (!dryRun && run('git', ['status', '--porcelain=v1', '--untracked-files=normal']) !== '')) {
      throw new Error('Source changed while packaging; the release was not uploaded.');
    }
    manifest = await archiveMacApp({
      appPath: join(root, 'release', 'mac-arm64', 'Roc.app'), directory, plan, env,
      run: (name, args) => run(name, args)
    });
  }
  const notesPath = writeMetadata(directory, manifest);
  if (dryRun) {
    return { dryRun: true, tag: plan.tag, sourceDirty, archivePath: join(directory, plan.assetName), sha256: manifest.asset.sha256 };
  }
  if (release === null) {
    gh([
      'release', 'create', plan.tag, '--target', commit, '--title', `Roc ${plan.tag.slice(1)}`,
      '--notes-file', notesPath, '--draft', `--prerelease=${plan.prerelease}`, '--latest=false'
    ]);
  } else {
    gh(['release', 'edit', plan.tag, '--notes-file', notesPath]);
  }
  release = api(`releases/tags/${encodeURIComponent(plan.tag)}`);
  for (const asset of expectedAssets(manifest, directory)) {
    if (matchingAsset(release, asset)) continue;
    gh(['release', 'upload', plan.tag, asset.path]);
    release = api(`releases/tags/${encodeURIComponent(plan.tag)}`);
    if (!matchingAsset(release, asset)) throw new Error(`Upload did not produce release asset ${asset.name}.`);
  }
  gh(['release', 'edit', plan.tag, '--draft=false', `--prerelease=${plan.prerelease}`, `--latest=${!plan.prerelease}`]);
  release = api(`releases/tags/${encodeURIComponent(plan.tag)}`);
  if (release.draft || release.prerelease !== plan.prerelease || !expectedAssets(manifest, directory).every((asset) => matchingAsset(release, asset))) {
    throw new Error(`Release ${plan.tag} did not finish publishing.`);
  }
  return { tag: plan.tag, url: release.html_url, sha256: manifest.asset.sha256, reused: false };
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' }, repo: { type: 'string' },
      'dry-run': { type: 'boolean', default: false }, plan: { type: 'boolean', default: false }
    },
    strict: true
  });
  const result = await releaseMac({ tag: values.tag, repository: values.repo, dryRun: values['dry-run'], planOnly: values.plan });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
