import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const releaseApiUrl = 'https://api.github.com/repos/rtk-ai/rtk/releases/latest';
const windowsAssetName = 'rtk-x86_64-pc-windows-msvc.zip';
const checksumAssetName = 'checksums.txt';
const expectedVersion = 'rtk 0.42.4';
const targetBinary = join(repoRoot, 'resources', 'rtk-binaries', 'win32-x64', 'rtk.exe');
const maxNetworkAttempts = 3;

async function main() {
  const release = await fetchJson(releaseApiUrl);
  const windowsAsset = findAsset(release, windowsAssetName);
  const checksumAsset = findAsset(release, checksumAssetName);
  const tempDir = await mkdtemp(join(tmpdir(), 'roc-rtk-update-'));
  try {
    const zipPath = join(tempDir, windowsAssetName);
    const checksumsPath = join(tempDir, checksumAssetName);
    await download(windowsAsset.browser_download_url, zipPath);
    await download(checksumAsset.browser_download_url, checksumsPath);
    await verifyChecksum(zipPath, checksumsPath);
    await extractRtk(zipPath, tempDir);
    const extractedBinary = join(tempDir, 'rtk.exe');
    await writeFile(targetBinary, await readFile(extractedBinary));
    const { stdout } = await execFileAsync(targetBinary, ['--version'], { windowsHide: true });
    const version = stdout.trim();
    if (version !== expectedVersion) {
      throw new Error(`Expected ${expectedVersion}, received ${version}.`);
    }
    console.log(`Updated ${targetBinary} to ${version}.`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchJson(url) {
  try {
    return await retryNetwork(async () => {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'roc-rtk-updater'
        }
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      }
      return await response.json();
    });
  } catch {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          '$ProgressPreference = "SilentlyContinue";',
          `Invoke-RestMethod -Uri ${quotePowerShell(url)} -Headers @{ "User-Agent" = "roc-rtk-updater" } | ConvertTo-Json -Depth 20`
        ].join(' ')
      ],
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(stdout);
  }
}

function findAsset(release, name) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((candidate) => candidate.name === name);
  if (asset === undefined || typeof asset.browser_download_url !== 'string') {
    throw new Error(`Release asset not found: ${name}`);
  }
  return asset;
}

async function download(url, destination) {
  try {
    await retryNetwork(async () => {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'roc-rtk-updater'
        }
      });
      if (!response.ok || response.body === null) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
      }
      await pipeline(response.body, createWriteStream(destination));
    });
  } catch {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          '$ProgressPreference = "SilentlyContinue";',
          `Invoke-WebRequest -Uri ${quotePowerShell(url)} -OutFile ${quotePowerShell(destination)} -Headers @{ "User-Agent" = "roc-rtk-updater" }`
        ].join(' ')
      ],
      { windowsHide: true }
    );
  }
}

async function retryNetwork(operation) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxNetworkAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxNetworkAttempts) {
        break;
      }
    }
  }
  throw lastError;
}

async function verifyChecksum(zipPath, checksumsPath) {
  const checksums = await readFile(checksumsPath, 'utf8');
  const expected = findChecksum(checksums, basename(zipPath));
  const actual = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${basename(zipPath)}: expected ${expected}, received ${actual}.`);
  }
}

function findChecksum(checksums, filename) {
  for (const line of checksums.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === filename) {
      return parts[0];
    }
  }
  throw new Error(`Checksum entry not found: ${filename}`);
}

async function extractRtk(zipPath, destination) {
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(destination)} -Force`
    ],
    { windowsHide: true }
  );
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

await main();
