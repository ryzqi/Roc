import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, link, mkdir, open, realpath, rm, unlink, writeFile} from 'node:fs/promises';
import {lookup} from 'node:dns/promises';
import type {LookupAddress} from 'node:dns';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import type {IncomingHttpHeaders, IncomingMessage} from 'node:http';
import {join, posix} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ToolResourceCoordinator} from '../../services/deep-agent/tool-resource-coordinator';
import type {PaperAcquisitionReceipt} from '../../../shared/schemas/literature-acquisition';
import {createResearchDirectory, researchWorkspace} from './research-files';
import {maximumDocumentBytes} from './document-files';
import type {PdfSourceCandidate} from './pdf-source-resolver';

export type PdfResponse = {status: number; headers: IncomingHttpHeaders; body: AsyncIterable<Uint8Array>; cancel(): void};
export type PdfDnsLookup = (hostname: string) => Promise<LookupAddress[]>;
export type PdfRequest = (url: URL, address: LookupAddress, signal: AbortSignal, connectSignal?: AbortSignal) => Promise<PdfResponse>;
export type PdfDownloadDependencies = {lookup?: PdfDnsLookup; request?: PdfRequest; maxBytes?: number; timeoutMs?: number;
  connectTimeoutMs?: number; now?: () => number};
export type PublishedPdf = {sha256: string; bytes: number; relativePath: string;
  receipt: Omit<PaperAcquisitionReceipt, 'id' | 'generation' | 'acquiredAt'>; created: boolean};

export type PdfPublication = { workspacePath: string; relativePath: string; temporaryPath: string; device: string; inode: string; sha256: string; bytes: number };
type RecordPublication = (file: PdfPublication) => void;

type InspectedPdf = {sha256: string; bytes: number};
export type PdfDownloadFailure = Error & {
  category: 'rate_limited' | 'temporary' | 'permanent' | 'restricted' | 'invalid_content';
  provider: PdfSourceCandidate['provider']; retryAfterMs: number | null;
};
const coordinator = new ToolResourceCoordinator();
const hostNextAt = new Map<string, number>();
const hostCooldownUntil = new Map<string, number>();
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maximumRetryAfterMs = 24 * 60 * 60_000;

/** Read only bounded retry metadata; never carry transport messages, URLs or causes across the adapter. */
export function pdfFailureRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('retryAfterMs' in error)) return null;
  const value = error.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximumRetryAfterMs) : null;
}

function safeDownloadFailure(error: unknown, provider: PdfSourceCandidate['provider']): PdfDownloadFailure {
  const code = error instanceof Error && /^research_[a-z][a-z0-9_]{2,100}$/u.test(error.message)
    ? error.message : 'research_pdf_transport_failed';
  const category: PdfDownloadFailure['category'] =
    code === 'research_pdf_http_retryable' && error instanceof Error && 'status' in error && error.status === 429 ? 'rate_limited' :
    /^research_pdf_(?:http_retryable|download_timeout|transport_failed)$/u.test(code) ? 'temporary' :
    code === 'research_pdf_restricted' ? 'restricted' :
    /^research_pdf_(?:content_invalid|size_invalid|staged_file_invalid)$/u.test(code) ? 'invalid_content' : 'permanent';
  return Object.assign(new Error(code), {category, provider, retryAfterMs: pdfFailureRetryAfterMs(error)});
}

function failurePriority(error: PdfDownloadFailure): number {
  if (/^research_pdf_(?:http_retryable|download_timeout|transport_failed)$/u.test(error.message)) return 3;
  if (error.message === 'research_pdf_restricted') return 2;
  return 1;
}

function ipv4Number(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
}
function inV4(address: string, base: string, maskBits: number): boolean {
  const value = ipv4Number(address), network = ipv4Number(base);
  if (value === null || network === null) return true;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (network & mask);
}

/** Rejects private, loopback, link-local, multicast and special-use DNS answers. */
export function isPublicPdfAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ![
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
  ].some(([base, bits]) => inV4(address, base as string, bits as number));
  if (family !== 6) return false;
  const words = ipv6Words(address);
  if (words === null) return false;
  if (words.slice(0, 5).every(value => value === 0) && words[5] === 0xffff) {
    return isPublicPdfAddress(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`);
  }
  const value = words.reduce((result, word) => (result << 16n) | BigInt(word), 0n);
  const inPrefix = (base: bigint, bits: number): boolean => (value >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
  // Accept global unicast only. Exclude IETF special-use, 6to4 and the
  // documentation range, including equivalent compressed/expanded spellings.
  const globalUnicast = inPrefix(0x20000000000000000000000000000000n, 3);
  const special2001 = inPrefix(0x20010000000000000000000000000000n, 23);
  return globalUnicast && !special2001 && !inPrefix(0x20020000000000000000000000000000n, 16) &&
    !inPrefix(0x20010db8000000000000000000000000n, 32) &&
    !inPrefix(0x3fff0000000000000000000000000000n, 20);
}

function ipv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase().split('%')[0];
  if (normalized === undefined || isIP(normalized) !== 6) return null;
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  if (dotted !== null) {
    const v4 = ipv4Number(dotted[1]!);
    if (v4 === null) return null;
    const replacement = `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    normalized = normalized.slice(0, normalized.length - dotted[1]!.length) + replacement;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (part: string): number[] | null => {
    if (part === '') return [];
    const values = part.split(':');
    if (values.some(value => !/^[\da-f]{1,4}$/u.test(value))) return null;
    return values.map(value => Number.parseInt(value, 16));
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? '');
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...left, ...Array.from({length: missing}, () => 0), ...right];
}

export function requirePdfUrl(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); } catch (cause) { throw new Error('research_pdf_url_invalid', {cause}); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443') || url.hash ||
    url.hostname.endsWith('.') || url.hostname.length === 0 || url.href.length > 4096) throw new Error('research_pdf_url_rejected');
  return url;
}

const defaultLookup: PdfDnsLookup = hostname => lookup(hostname, {all: true, verbatim: true});
const defaultRequest: PdfRequest = (url, address, signal, connectSignal) => new Promise((resolve, reject) => {
  let response: IncomingMessage | null = null;
  let req: ReturnType<typeof httpsRequest>;
  const abortBeforeResponse = (): void => {
    if (response === null) req.destroy(connectSignal?.reason instanceof Error ? connectSignal.reason : new Error('research_pdf_connect_timeout'));
  };
  req = httpsRequest(url, {method: 'GET', agent: false, signal,
    headers: {'accept': 'application/pdf, application/octet-stream;q=0.9, */*;q=0.1', 'accept-encoding': 'identity', 'user-agent': 'Roc-PdfAcquisition/1.0'},
    lookup: (_hostname, options, done) => {
      if (typeof options === 'object' && options.all) done(null, [address]);
      else done(null, address.address, address.family);
    }}, incoming => {
      response = incoming;
      connectSignal?.removeEventListener('abort', abortBeforeResponse);
      resolve({status: incoming.statusCode ?? 0, headers: incoming.headers,
        body: incoming as AsyncIterable<Uint8Array>, cancel: () => incoming.destroy()});
    });
  if (connectSignal?.aborted) abortBeforeResponse();
  else connectSignal?.addEventListener('abort', abortBeforeResponse, {once: true});
  req.once('error', error => { if (response === null) reject(error); });
  req.end();
});

function responseHeader(response: PdfResponse, name: string): string | null {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
function retryAfter(value: string | null, now: number): number | null {
  if (value === null || !value.trim()) return null;
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.min(seconds * 1000, maximumRetryAfterMs) : null;
  }
  const date = /[a-z]/iu.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, Math.min(date - now, maximumRetryAfterMs)) : null;
}
function sanitizedUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}
function pdfFilename(title: string, year: number | null, itemId: string): string {
  const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80).replace(/-+$/u, '') || 'paper';
  const yearPart = year !== null && year >= 1000 && year <= 9999 ? year : 'undated';
  const stable = createHash('sha256').update(itemId).digest('hex').slice(0, 12);
  return `papers/${yearPart}/${slug}--${stable}.pdf`;
}
function isPdf(header: Buffer, tail: Buffer, bytes: number): boolean {
  return bytes >= 100 && header.includes(Buffer.from('%PDF-')) && tail.includes(Buffer.from('%%EOF'));
}
function mapVersion(candidate: PdfSourceCandidate): PaperAcquisitionReceipt['version'] {
  if (candidate.version === 'publishedVersion' || candidate.version === 'published') return 'published';
  if (candidate.version === 'acceptedVersion' || candidate.version === 'accepted') return 'accepted';
  if (candidate.provider === 'arxiv' || candidate.version?.toLowerCase().includes('submitted') === true || candidate.version?.startsWith('v') === true) return 'preprint';
  return 'unknown';
}
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      listener = () => reject(signal.reason ?? new Error('research_pdf_download_aborted'));
      signal.addEventListener('abort', listener, {once: true});
      if (signal.aborted) listener();
    })]);
  } finally { if (listener !== undefined) signal.removeEventListener('abort', listener); }
}

async function inspectFile(path: string, maxBytes: number): Promise<InspectedPdf> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error('research_pdf_staged_file_invalid');
    const hash = createHash('sha256');
    let header = Buffer.alloc(0), tail = Buffer.alloc(0), position = 0;
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      if (header.length < 1024) header = Buffer.concat([header, chunk.subarray(0, 1024 - header.length)]);
      tail = Buffer.concat([tail, chunk]).subarray(-2048);
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (position !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || !isPdf(header, tail, position)) {
      throw new Error('research_pdf_staged_file_invalid');
    }
    return {sha256: hash.digest('hex'), bytes: position};
  } finally { await handle.close(); }
}

/** Downloads provider-designated candidates with pinned public DNS and no-replace workspace publication. */
export class PdfDownloadService {
  private readonly dns: PdfDnsLookup;
  private readonly request: PdfRequest;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;
  private root: string;

  constructor(resourceRoot: string, dependencies: PdfDownloadDependencies = {}) {
    this.root = resourceRoot;
    this.dns = dependencies.lookup ?? defaultLookup;
    this.request = dependencies.request ?? defaultRequest;
    this.maxBytes = dependencies.maxBytes ?? maximumDocumentBytes;
    this.timeoutMs = dependencies.timeoutMs ?? 90_000;
    this.connectTimeoutMs = dependencies.connectTimeoutMs ?? 10_000;
    this.now = dependencies.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 100 || this.maxBytes > maximumDocumentBytes ||
      !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isSafeInteger(this.connectTimeoutMs) || this.connectTimeoutMs < 1) {
      throw new Error('research_pdf_download_limits_invalid');
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, {recursive: true, mode: 0o700});
    const info = await lstat(this.root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('research_pdf_storage_unavailable');
    this.root = await realpath(this.root);
    await createResearchDirectory(this.root, 'literature-pdf');
  }

  /** Global-library downloads have an app-owned workspace until a project links them. */
  async libraryWorkspace(): Promise<string> {
    return await createResearchDirectory(this.root, 'literature-pdf-library');
  }

  async publishExisting(input: {jobId: string; generation: string; libraryItemId: string; title: string; year: number | null;
    workspacePath: string; bytes: Buffer; signal: AbortSignal; requireCurrent: () => void;
    notifyWorkspaceChanged: (workspacePath: string, reason: string) => void; recordPublication?: RecordPublication}): Promise<PublishedPdf> {
    input.signal.throwIfAborted(); input.requireCurrent();
    if (input.bytes.length > this.maxBytes) throw new Error('research_pdf_size_invalid');
    const stablePath = pdfFilename(input.title, input.year, input.libraryItemId);
    const root = await researchWorkspace(input.workspacePath);
    const destinationDirectory = await createResearchDirectory(root, stablePath.slice(0, stablePath.lastIndexOf('/')));
    const stageDirectory = await createResearchDirectory(this.root, `literature-pdf/${createHash('sha256').update(input.jobId).digest('hex')}/${input.generation}-${randomUUID()}`);
    const stagedPdf = join(stageDirectory, 'source.pdf');
    try {
      await writeFile(stagedPdf, input.bytes, {mode: 0o600, flag: 'wx'});
      const inspected = await inspectFile(stagedPdf, this.maxBytes);
      input.signal.throwIfAborted(); input.requireCurrent();
      const {created, relativePath} = await this.publishVersioned(destinationDirectory, stablePath, stagedPdf, inspected,
        input.signal, input.requireCurrent, root, input.recordPublication);
      if (created) input.notifyWorkspaceChanged(root, 'literature-pdf-published');
      return {...inspected, relativePath, created, receipt: {...inspected, relativePath, sourceUrl: null,
        provider: 'library', version: 'unknown', license: null, doi: null, arxivId: null}};
    } finally {await rm(stageDirectory, {recursive: true, force: true});}
  }

  async acquire(input: {jobId: string; generation: string; libraryItemId: string; title: string; year: number | null;
    workspacePath: string; candidates: readonly PdfSourceCandidate[]; signal: AbortSignal; requireCurrent: () => void;
    notifyWorkspaceChanged: (workspacePath: string, reason: string) => void; recordPublication?: RecordPublication}): Promise<PublishedPdf> {
    input.signal.throwIfAborted();
    input.requireCurrent();
    if (input.candidates.length === 0) throw new Error('research_pdf_sources_unavailable');
    const stablePath = pdfFilename(input.title, input.year, input.libraryItemId);
    const root = await researchWorkspace(input.workspacePath);
    const destinationDirectory = await createResearchDirectory(root, stablePath.slice(0, stablePath.lastIndexOf('/')));
    const stagePath = `literature-pdf/${createHash('sha256').update(input.jobId).digest('hex')}/${input.generation}`;
    const stageDirectory = await createResearchDirectory(this.root, stagePath);
    const stagedPdf = join(stageDirectory, 'source.pdf');
    await unlink(stagedPdf).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    let failure: PdfDownloadFailure | null = null;
    let retryAt = 0;
    try {
      for (const candidate of input.candidates) {
        input.signal.throwIfAborted();
        input.requireCurrent();
        try {
          const downloaded = await this.downloadCandidate(candidate.url, stagedPdf, input.signal);
          input.requireCurrent();
          const {created, relativePath} = await this.publishVersioned(destinationDirectory, stablePath, stagedPdf, downloaded,
            input.signal, input.requireCurrent, root, input.recordPublication);
          if (created) input.notifyWorkspaceChanged(root, 'literature-pdf-published');
          const receipt = {sha256: downloaded.sha256, bytes: downloaded.bytes, sourceUrl: sanitizedUrl(candidate.url),
            provider: candidate.provider, version: mapVersion(candidate), license: candidate.license,
            doi: candidate.doi, arxivId: candidate.arxivId, relativePath};
          return {sha256: downloaded.sha256, bytes: downloaded.bytes, relativePath, receipt, created};
        } catch (error) {
          const safe = safeDownloadFailure(error, candidate.provider);
          await unlink(stagedPdf).catch(cleanupError => {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
          });
          if (input.signal.aborted) throw input.signal.reason;
          input.requireCurrent();
          if (error instanceof Error && error.message === 'literature_acquisition_changed') throw error;
          if (/^(?:research_pdf_(?:workspace|project|path|storage|publication|name|existing_file_conflict)|research_(?:project_workspace_required|path_outside_project|path_symlink|directory_invalid|library_storage))/u.test(safe.message)) throw safe;
          // Any retryable source keeps the paper eligible. A later missing/restricted copy must not hide it.
          const deadline = safe.retryAfterMs === null ? 0 : this.now() + safe.retryAfterMs;
          if (failure === null || failurePriority(safe) > failurePriority(failure) ||
            failurePriority(safe) === failurePriority(failure) && deadline > retryAt) {
            failure = safe;
            retryAt = deadline;
          }
        }
      }
      if (failure !== null && failure.retryAfterMs !== null) failure.retryAfterMs = Math.max(0, retryAt - this.now());
      throw failure ?? new Error('research_pdf_sources_unavailable');
    } finally {
      await rm(stageDirectory, {recursive: true, force: true});
    }
  }

  private async downloadCandidate(rawUrl: string, stagedPdf: string, signal: AbortSignal): Promise<InspectedPdf> {
    const initial = requirePdfUrl(rawUrl);
    try { return await inspectFile(stagedPdf, this.maxBytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof Error && error.message === 'research_pdf_staged_file_invalid') await unlink(stagedPdf).catch(() => undefined);
        else throw error;
      }
    }
    const partial = `${stagedPdf}.${randomUUID()}.part`;
    const handle = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let closed = false, total = 0, header = Buffer.alloc(0), tail = Buffer.alloc(0);
    const hash = createHash('sha256');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      let current = initial;
      for (let redirects = 0; ; redirects++) {
        requestSignal.throwIfAborted();
        const dnsTimeout = AbortSignal.any([requestSignal, AbortSignal.timeout(this.connectTimeoutMs)]);
        const hostname = current.hostname.startsWith('[') && current.hostname.endsWith(']') ? current.hostname.slice(1, -1) : current.hostname;
        const addresses = await withAbort(this.dns(hostname), dnsTimeout);
        requestSignal.throwIfAborted();
        if (addresses.length === 0 || addresses.some(value => !isPublicPdfAddress(value.address))) throw new Error('research_pdf_address_rejected');
        const address = addresses[0]!;
        const release = await coordinator.acquire([{kind: 'network', key: `literature-pdf:${current.hostname}`, access: 'write'}], requestSignal);
        try {
          const cooldown = (hostCooldownUntil.get(current.hostname) ?? 0) - this.now();
          if (cooldown > 0) throw Object.assign(new Error('research_pdf_http_retryable'), {retryAfterMs: cooldown});
          hostCooldownUntil.delete(current.hostname);
          const remaining = Math.max(0, (hostNextAt.get(current.hostname) ?? 0) - this.now());
          if (remaining > 0) await delay(remaining, undefined, {signal: requestSignal});
          hostNextAt.set(current.hostname, this.now() + 1000);
          let connectTimedOut = false;
          const connectController = new AbortController();
          const connectTimer = setTimeout(() => {
            connectTimedOut = true;
            connectController.abort(new Error('research_pdf_connect_timeout'));
          }, this.connectTimeoutMs);
          connectTimer.unref();
          const requestAbort = AbortSignal.any([requestSignal, connectController.signal]);
          let response: PdfResponse;
          try {
            response = await withAbort(this.request(current, address, requestAbort, connectController.signal), requestAbort);
          } catch (error) {
            if (connectTimedOut) throw new Error('research_pdf_download_timeout', {cause: error});
            throw error;
          } finally {
            clearTimeout(connectTimer);
          }
          try {
            if (redirectStatuses.has(response.status)) {
              if (redirects >= 5) throw new Error('research_pdf_redirect_limit');
              const location = responseHeader(response, 'location');
              if (location === null) throw new Error('research_pdf_redirect_invalid');
              current = requirePdfUrl(new URL(location, current));
              continue;
            }
            if (response.status !== 200) {
              const transient = response.status === 429 || response.status >= 500 && response.status <= 599;
              const wait = transient ? retryAfter(responseHeader(response, 'retry-after'), this.now()) : null;
              if (wait !== null && wait > 0) hostCooldownUntil.set(current.hostname,
                Math.max(hostCooldownUntil.get(current.hostname) ?? 0, this.now() + wait));
              const code = response.status === 404 || response.status === 410 ? 'research_pdf_unavailable' :
                response.status === 401 || response.status === 403 ? 'research_pdf_restricted' :
                  transient ? 'research_pdf_http_retryable' : 'research_pdf_http_error';
              throw Object.assign(new Error(code), {status: response.status, retryAfterMs: wait});
            }
            const encoding = responseHeader(response, 'content-encoding');
            const length = responseHeader(response, 'content-length');
            if ((encoding !== null && encoding.toLowerCase() !== 'identity') ||
              (length !== null && (!/^\d+$/u.test(length) || Number(length) > this.maxBytes))) throw new Error('research_pdf_size_invalid');
            for await (const chunk of response.body) {
              requestSignal.throwIfAborted();
              if (chunk.byteLength > this.maxBytes - total) throw new Error('research_pdf_size_invalid');
              const bytes = Buffer.from(chunk);
              if (header.length < 1024) header = Buffer.concat([header, bytes.subarray(0, 1024 - header.length)]);
              tail = Buffer.concat([tail, bytes]).subarray(-2048);
              hash.update(bytes);
              let offset = 0;
              while (offset < bytes.length) {
                const result = await handle.write(bytes, offset, bytes.length - offset, total + offset);
                if (result.bytesWritten === 0) throw new Error('research_pdf_storage_failed');
                offset += result.bytesWritten;
              }
              total += bytes.length;
            }
            if ((length !== null && Number(length) !== total) || !isPdf(header, tail, total)) throw new Error('research_pdf_content_invalid');
            requestSignal.throwIfAborted();
            await handle.sync();
            await handle.close(); closed = true;
            try { await link(partial, stagedPdf); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            await unlink(partial);
            return {sha256: hash.digest('hex'), bytes: total};
          } finally { response.cancel(); }
        } finally { release(); }
      }
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new Error('research_pdf_download_timeout', {cause: error});
      if ((requestSignal.aborted || error instanceof Error && error.name === 'TimeoutError') && !signal.aborted) {
        throw new Error('research_pdf_download_timeout', {cause: error});
      }
      throw error;
    } finally {
      if (!closed) await handle.close();
      await unlink(partial).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }

  private async publishVersioned(directory: string, stablePath: string, stagedPdf: string, inspected: InspectedPdf,
    signal: AbortSignal, requireCurrent: () => void, workspacePath: string, recordPublication?: RecordPublication): Promise<{relativePath: string; created: boolean}> {
    let relativePath = stablePath;
    const publish = async (): Promise<boolean> => {
      signal.throwIfAborted(); requireCurrent();
      return this.publish(directory, relativePath, stagedPdf,
        inspected.sha256, inspected.bytes, signal, requireCurrent, workspacePath, recordPublication);
    };
    try {return {relativePath, created: await publish()};}
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'research_pdf_existing_file_conflict') throw error;
      // All sources share the same immutable publication policy; neither path overwrites existing bytes.
      relativePath = stablePath.replace(/\.pdf$/u, `--${inspected.sha256.slice(0, 16)}.pdf`);
      return {relativePath, created: await publish()};
    }
  }

  private async publish(directory: string, relativePath: string, stagedPdf: string, sha256: string, bytes: number,
    signal: AbortSignal, requireCurrent: () => void, workspacePath: string, recordPublication?: RecordPublication): Promise<boolean> {
    const destination = join(directory, posix.basename(relativePath));
    const temporaryName = `.roc-${randomUUID()}.part`;
    const temporary = join(directory, temporaryName);
    const source = await open(stagedPdf, constants.O_RDONLY | constants.O_NOFOLLOW);
    const target = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let temporaryExists = true, sourceClosed = false, targetClosed = false;
    try {
      if (recordPublication) {
        const info = await target.stat({bigint: true});
        signal.throwIfAborted(); requireCurrent();
        // The inode is known before the final name exists. A pre-existing file reused
        // by the download has a different inode and never becomes a deletion target.
        recordPublication({workspacePath, relativePath, temporaryPath: posix.join(posix.dirname(relativePath), temporaryName),
          device: String(info.dev), inode: String(info.ino), sha256, bytes});
      }
      const sourceInfo = await source.stat();
      if (!sourceInfo.isFile() || sourceInfo.size !== bytes) throw new Error('research_pdf_staged_file_invalid');
      const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
      let position = 0;
      for (;;) {
        signal.throwIfAborted(); requireCurrent();
        const result = await source.read(buffer, 0, buffer.length, position);
        if (result.bytesRead === 0) break;
        const chunk = buffer.subarray(0, result.bytesRead);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await target.write(chunk, offset, chunk.length - offset, position + offset);
          if (written.bytesWritten === 0) throw new Error('research_pdf_storage_failed');
          offset += written.bytesWritten;
        }
        position += result.bytesRead;
      }
      if (position !== bytes || hash.digest('hex') !== sha256) throw new Error('research_pdf_staged_file_changed');
      await target.sync();
      await source.close(); sourceClosed = true;
      await target.close(); targetClosed = true;
      signal.throwIfAborted(); requireCurrent();
      try {
        await link(temporary, destination);
        await unlink(temporary); temporaryExists = false;
        const directoryHandle = await open(directory, constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let existing: InspectedPdf;
        try { existing = await inspectFile(destination, this.maxBytes); }
        catch (cause) { throw new Error('research_pdf_existing_file_conflict', {cause}); }
        if (existing.bytes !== bytes || existing.sha256 !== sha256) throw new Error('research_pdf_existing_file_conflict');
        return false;
      }
    } finally {
      if (!sourceClosed) await source.close();
      if (!targetClosed) await target.close();
      if (temporaryExists) await rm(temporary, {force: true});
    }
  }
}
