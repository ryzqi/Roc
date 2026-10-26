import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, type FileHandle } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { basename, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { decodeJsonOrNull } from '../lib/decode-json.ts';

/** 构建期下载：保留分块断点，校验资源身份与最终 SHA-256。 */

const HEADERS = {
  'User-Agent': 'Tectonic/0.17.0',
  'Accept-Encoding': 'identity'
} as const;

const TIMEOUT_MS = 45_000;
const COPY_CHUNK = 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_WORKERS = 4;
const DEFAULT_ATTEMPTS = 36;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type RemoteFile = {
  url: string;
  size: number;
  etag: string | null;
};

type SourceIdentity = {
  url: string;
  size: number;
  etag: string | null;
  chunkSize: number;
};

type HttpWithProxy = typeof http & { setGlobalProxyFromEnv?: (env?: NodeJS.ProcessEnv) => () => void };

let proxyApplied = false;

function fail(code: string): never {
  throw new Error(code);
}

function applyProxy(): void {
  if (proxyApplied) return;
  proxyApplied = true;
  (http as HttpWithProxy).setGlobalProxyFromEnv?.();
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isSourceIdentity(value: unknown): value is SourceIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4
    && typeof record.url === 'string'
    && Number.isInteger(record.size)
    && (record.etag === null || typeof record.etag === 'string')
    && Number.isInteger(record.chunkSize);
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.url === right.url && left.size === right.size && left.etag === right.etag && left.chunkSize === right.chunkSize;
}

async function writeAll(file: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset);
    if (bytesWritten === 0) {
      throw Object.assign(new Error('research_download_incomplete'), { code: 'research_download_incomplete' });
    }
    offset += bytesWritten;
  }
}

function downloadAbortError(): Error {
  return Object.assign(new Error('research_download_cancelled'), { code: 'research_download_cancelled' });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw downloadAbortError();
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return !error.message.startsWith('research_download_cancelled')
    && !error.message.startsWith('research_download_source_changed')
    && !error.message.startsWith('research_download_chunk_size_invalid')
    && !error.message.startsWith('research_download_cache_symlink')
    && !error.message.startsWith('research_download_options_invalid');
}

async function delayAttempt(attempt: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, Math.min(2 ** attempt, 10) * 1000);
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(downloadAbortError());
    };
    function finish(): void {
      cleanup();
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function send(lib: typeof http | typeof https, options: http.RequestOptions, signal?: AbortSignal): Promise<IncomingMessage> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const request = lib.request(options);
    const cleanup = () => signal?.removeEventListener('abort', onSignalAbort);
    const onSignalAbort = () => request.destroy(downloadAbortError());
    request.once('response', (response) => {
      cleanup();
      resolve(response);
    });
    request.setTimeout(TIMEOUT_MS, () => {
      request.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    });
    request.once('error', (error) => {
      cleanup();
      reject(error);
    });
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
    request.end();
  });
}

async function rangeRequest(url: string, extra: Record<string, string>, hops = 0, signal?: AbortSignal): Promise<IncomingMessage> {
  throwIfAborted(signal);
  applyProxy();
  if (hops > 10) throw Object.assign(new Error('research_download_incomplete'), { code: 'research_download_redirect_limit' });
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    fail('research_download_url_invalid');
  }
  const lib = target.protocol === 'https:' ? https : http;
  const response = await send(lib, {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port === '' ? undefined : target.port,
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers: { ...HEADERS, ...extra }
  }, signal);
  const status = response.statusCode ?? 0;
  if (REDIRECT_STATUSES.has(status)) {
    const location = headerValue(response.headers, 'location');
    response.resume();
    if (location === undefined || location === '') {
      throw Object.assign(new Error('research_download_incomplete'), { code: 'research_download_redirect_invalid' });
    }
    return rangeRequest(new URL(location, target).toString(), extra, hops + 1, signal);
  }
  return response;
}

async function readBody(response: IncomingMessage, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const body = Buffer.concat(chunks, size);
      if (signal?.aborted || error?.message.startsWith('research_download_cancelled') || (body.length === 0 && error !== undefined)) reject(error ?? downloadAbortError());
      else resolve(body);
    };
    const onTimeout = () => finish(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    const onSignalAbort = () => {
      response.destroy();
      finish(downloadAbortError());
    };
    const cleanup = () => {
      response.off('data', onData);
      response.off('end', onEnd);
      response.off('error', onError);
      response.off('aborted', onAbort);
      response.off('close', onClose);
      response.off('timeout', onTimeout);
      signal?.removeEventListener('abort', onSignalAbort);
    };
    const onData = (chunk: Buffer | string) => {
      if (size >= maxBytes) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const slice = buffer.length > maxBytes - size ? buffer.subarray(0, maxBytes - size) : buffer;
      chunks.push(slice);
      size += slice.length;
      if (size >= maxBytes) {
        response.pause();
        finish();
      }
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    const onClose = () => finish(Object.assign(new Error('closed'), { code: 'ECONNRESET' }));
    response.setTimeout(TIMEOUT_MS, onTimeout);
    response.on('data', onData);
    response.on('end', onEnd);
    response.on('error', onError);
    response.on('aborted', onAbort);
    response.on('close', onClose);
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
  });
}

async function readAtMost(response: IncomingMessage, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readBody(response, maxBytes, signal);
  } finally {
    response.resume();
    response.destroy();
  }
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function probe(url: string, signal?: AbortSignal): Promise<RemoteFile> {
  throwIfAborted(signal);
  const response = await rangeRequest(url, { Range: 'bytes=0-0' }, 0, signal);
  const contentRange = headerValue(response.headers, 'content-range') ?? '';
  const match = /^bytes 0-0\/(\d+)$/u.exec(contentRange);
  if (response.statusCode !== 206 || match === null) fail('research_download_range_required');
  const size = Number(match[1]);
  const body = await readAtMost(response, 2, signal);
  if (!Number.isInteger(size) || size < 1 || body.length !== 1) fail('research_download_size_invalid');
  const etag = headerValue(response.headers, 'etag');
  return { url, size, etag: etag === undefined ? null : etag };
}

async function writeIdentity(marker: string, identity: SourceIdentity): Promise<void> {
  const info = await pathInfo(marker);
  if (info?.isSymbolicLink()) fail('research_download_cache_symlink');
  if (info !== null) {
    const existing = decodeJsonOrNull<SourceIdentity>(await readFile(marker, 'utf8'));
    if (!isSourceIdentity(existing) || !sameIdentity(existing, identity)) {
      fail('research_download_source_changed');
    }
    return;
  }
  const file = await open(marker, 'wx');
  try {
    await file.writeFile(JSON.stringify(identity), 'utf8');
  } finally {
    await file.close();
  }
}

async function fetchChunk(
  remote: RemoteFile,
  part: string,
  index: number,
  chunkSize: number,
  attempts: number,
  delay: (attempt: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const info = await pathInfo(part);
  if (info?.isSymbolicLink()) fail('research_download_cache_symlink');
  const length = Math.min(chunkSize, remote.size - index * chunkSize);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await pathInfo(part);
    const offset = current === null ? 0 : current.size;
    if (offset > length) fail('research_download_chunk_size_invalid');
    if (offset === length) return;
    const start = index * chunkSize + offset;
    const end = index * chunkSize + length - 1;
    const headers: Record<string, string> = { Range: `bytes=${start}-${end}` };
    if (remote.etag !== null) headers['If-Range'] = remote.etag;
    let response: IncomingMessage | undefined;
    try {
      response = await rangeRequest(remote.url, headers, 0, signal);
      const expectedRange = `bytes ${start}-${end}/${remote.size}`;
      const encoding = headerValue(response.headers, 'content-encoding') ?? 'identity';
      if (response.statusCode !== 206
          || headerValue(response.headers, 'content-range') !== expectedRange
          || headerValue(response.headers, 'etag') !== (remote.etag ?? undefined)
          || encoding !== 'identity') {
        fail('research_download_source_changed');
      }
      const remaining = length - offset;
      const body = await readBody(response, remaining, signal);
      if (body.length === 0) {
        throw Object.assign(new Error('research_download_incomplete'), { code: 'research_download_incomplete' });
      }
      const file = await open(part, 'a');
      try {
        await writeAll(file, body);
        await file.sync();
      } finally {
        await file.close();
      }
      if (body.length !== remaining) {
        throw Object.assign(new Error('research_download_incomplete'), { code: 'research_download_incomplete' });
      }
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt + 1 === attempts) {
        if (!isRetryable(error)) throw error;
        throw Object.assign(new Error(`research_download_chunk_incomplete:${index}`), { cause: error });
      }
      await delay(attempt);
    } finally {
      response?.resume();
      response?.destroy();
    }
  }
}

async function assemble(partsDir: string, target: string, count: number): Promise<void> {
  const assembling = join(partsDir, 'assembled');
  if ((await pathInfo(assembling))?.isSymbolicLink()) fail('research_download_cache_symlink');
  const output = await open(assembling, 'w');
  try {
    for (let index = 0; index < count; index += 1) {
      const source = await open(join(partsDir, `${String(index).padStart(6, '0')}.part`), 'r');
      try {
        const buffer = Buffer.alloc(COPY_CHUNK);
        while (true) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          await writeAll(output, buffer.subarray(0, bytesRead));
        }
      } finally {
        await source.close();
      }
    }
    await output.sync();
  } finally {
    await output.close();
  }
  await rename(assembling, target);
}

export async function downloadRanges(
  remote: RemoteFile,
  target: string,
  options: {
    chunkSize?: number;
    workers?: number;
    attempts?: number;
    delay?: (attempt: number) => Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<void> {
  throwIfAborted(options.signal);
  const controller = new AbortController();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const workers = options.workers ?? DEFAULT_WORKERS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delay = options.delay ?? ((attempt) => delayAttempt(attempt, signal));
  if (remote.size < 1 || chunkSize < 1 || workers < 1 || attempts < 1) fail('research_download_options_invalid');
  const targetInfo = await pathInfo(target);
  if (targetInfo !== null) fail('research_download_target_exists');
  const partsDir = `${target}.parts`;
  if ((await pathInfo(partsDir))?.isSymbolicLink()) fail('research_download_cache_symlink');
  await mkdir(partsDir, { recursive: true });
  const identity: SourceIdentity = { url: remote.url, size: remote.size, etag: remote.etag, chunkSize };
  await writeIdentity(join(partsDir, 'source.json'), identity);
  const count = Math.floor((remote.size + chunkSize - 1) / chunkSize);
  let next = 0;
  let completed = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      try {
        await fetchChunk(remote, join(partsDir, `${String(index).padStart(6, '0')}.part`), index, chunkSize, attempts, delay, signal);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
      completed += 1;
      if (completed % 32 === 0 || completed === count) {
        console.log(`资源分块 ${completed}/${count}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, count) }, () => runWorker()));
  await assemble(partsDir, target, count);
}

export async function downloadVerified(
  url: string,
  expectedSha256: string,
  target: string,
  options: { expectedSize?: number; signal?: AbortSignal } = {}
): Promise<string> {
  throwIfAborted(options.signal);
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) fail('research_download_digest_invalid');
  const info = await pathInfo(target);
  if (info?.isSymbolicLink()) fail('research_download_target_symlink');
  if (info === null) {
    const remote = await probe(url, options.signal);
    if (options.expectedSize !== undefined && remote.size !== options.expectedSize) {
      fail('research_download_size_mismatch');
    }
    await downloadRanges(remote, target, { signal: options.signal });
  }
  const after = await lstat(target);
  const digest = await fileSha256(target);
  if ((options.expectedSize !== undefined && after.size !== options.expectedSize) || digest !== expectedSha256) {
    fail(`research_download_hash_mismatch:${basename(target)}`);
  }
  return target;
}
