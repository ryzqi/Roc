#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/*
 * Node 的 fetch 不读 `HTTP(S)_PROXY`，只有 `NODE_USE_ENV_PROXY=1` 才让内置的 undici 用代理——
 * 而它只在进程启动时读一次。所以在「机器配了代理、但没设这个变量」时用同一份参数重启自己，
 * 否则下载会以 `UND_ERR_CONNECT_TIMEOUT` 失败，看起来像 GitHub 挂了。
 */
const proxyEnvNames = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY'];
if (process.env.NODE_USE_ENV_PROXY !== '1' && proxyEnvNames.some((name) => (process.env[name] ?? '').length > 0)) {
  const reexec = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' }
  });
  process.exit(reexec.status ?? 1);
}

/**
 * 重新拉取随包分发的 ripgrep 二进制。
 *
 * 为什么是脚本而不是 `pnpm add @vscode/ripgrep`：Roc 只分发 darwin arm64，二进制必须
 * 与 `electron-builder.yml` 的 `darwin-arm64` 过滤一一对应，且升级时要同时记录版本、上游
 * 网址、许可证与 SHA-256（README 的「外部集成」是这些事实的唯一登记处）。npm 包会把工具链
 * 的完整性交给第三方 postinstall，这里改为对齐 `resources/research-runtime/tools.lock.json`
 * 的做法：锁定文件是真理源，脚本只负责按锁定文件取物并核对。
 *
 * 用法：
 *
 * ```bash
 * pnpm sync:ripgrep             # 按 ripgrep.lock.json 取两个架构
 * pnpm sync:ripgrep --arch arm64
 * ```
 *
 * 产物：`resources/ripgrep-binaries/darwin-<arch>/rg`（755）。许可证文本已随仓库提交，
 * 因此脚本只取二进制，不覆盖 `licenses/`。
 */

const lockPath = new URL('../resources/ripgrep-binaries/ripgrep.lock.json', import.meta.url);
const outputRoot = new URL('../resources/ripgrep-binaries/', import.meta.url);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const DOWNLOAD_ATTEMPTS = 5;

/**
 * 取资产并重试。
 *
 * 为什么不是一次 `fetch`：GitHub 的 release 资产偶尔在 TLS 层直接断连（`UND_ERR_SOCKET`），
 * 这在“一次性脚本、失败就重跑”的人眼里只是噪音，但在打包/升级流程里是必须自己处理的抖动。
 * 只对网络错误重试；HTTP 状态码不重试——404/403 重试也还是 404/403。
 */
async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) {
        throw new Error(`ripgrep_download_failed:${response.status}:${url}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ripgrep_download_failed:')) {
        throw error;
      }
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        console.warn(`ripgrep download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw new Error(`ripgrep_download_failed:network:${url}:${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function extractBinary(archivePath, tempDir, binaryName) {
  execFileSync('tar', ['-xzf', archivePath, '-C', tempDir], { stdio: 'inherit' });
  const entries = execFileSync('find', [tempDir, '-type', 'f', '-name', binaryName], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
  if (entries.length !== 1) {
    throw new Error(`ripgrep_binary_not_unique:${entries.length}`);
  }
  return readFileSync(entries[0]);
}

async function syncArchitecture(arch, entry) {
  const archive = await download(entry.url);
  const archiveDigest = sha256(archive);
  if (archiveDigest !== entry.archiveSha256) {
    throw new Error(`ripgrep_archive_sha256_mismatch:${arch}:${archiveDigest}`);
  }
  if (archive.byteLength !== entry.archiveSize) {
    throw new Error(`ripgrep_archive_size_mismatch:${arch}:${archive.byteLength}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'roc-ripgrep-'));
  try {
    const archivePath = join(tempDir, entry.asset);
    writeFileSync(archivePath, archive);
    const binary = extractBinary(archivePath, tempDir, 'rg');
    const binaryDigest = sha256(binary);
    if (binaryDigest !== entry.binarySha256) {
      throw new Error(`ripgrep_binary_sha256_mismatch:${arch}:${binaryDigest}`);
    }
    const destination = join(outputRoot.pathname, entry.platformDir, 'rg');
    writeFileSync(destination, binary);
    chmodSync(destination, 0o755);
    console.log(`ripgrep ${arch} -> ${destination} (${binary.byteLength} bytes, sha256 ${binaryDigest})`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(`ripgrep_lock_unreadable:${error instanceof Error ? error.message : String(error)}`);
  }
}

const { values } = parseArgs({ options: { arch: { type: 'string' } } });
const lock = readLock();
const targets = values.arch === undefined ? Object.entries(lock.architectures) : [[values.arch, lock.architectures[values.arch]]];
if (targets.length === 0 || targets.some(([, entry]) => entry === undefined)) {
  throw new Error(`ripgrep_arch_unknown:${values.arch ?? ''}`);
}

if (!existsSync(outputRoot)) {
  throw new Error(`ripgrep_output_missing:${outputRoot.pathname}`);
}

for (const [arch, entry] of targets) {
  await syncArchitecture(arch, entry);
}
