import {PDFDataRangeTransport} from 'pdfjs-dist';

const chunkBytes = 256 * 1024;
const wireRangeBytes = 1024 * 1024;
const maximumLegacyBytes = 8 * 1024 * 1024;
const maximumRequestBytes = 64 * 1024 * 1024;
const maximumQueuedRequests = 32;
const maximumConcurrentRequests = 2;
type Job = {begin: number; end: number};
type Session = {url: string; id: string; size: number};
export type PdfSource = {
  data?: Uint8Array<ArrayBuffer>; range?: PDFDataRangeTransport;
  rangeChunkSize?: number; disableStream?: boolean; disableAutoFetch?: boolean;
  dispose: () => void;
};

function sourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'roc-preview:' || url.hostname !== 'research' ||
      !/^\/projects\/[^/]+\/documents\/[^/]+\/source\/[a-f0-9]{64}$/u.test(url.pathname)) {
    throw new Error('原 PDF 资源地址无效。');
  }
  return url;
}

function sessionUrl(url: string, session: string | null): string {
  const target = sourceUrl(url);
  target.search = '';
  if (session !== null) target.searchParams.set('session', session);
  return target.href;
}

async function boundedBytes(response: Response, expected: number): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) throw new Error('原 PDF 资源没有返回数据。');
  const reader = response.body.getReader(), bytes = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      if (value.length > expected - offset) throw new Error('原 PDF 资源大小与版本不一致。');
      bytes.set(value, offset); offset += value.length;
    }
    if (offset !== expected) throw new Error('原 PDF 资源读取不完整。');
    return bytes;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function head(url: string, signal: AbortSignal): Promise<Response> {
  let response = await fetch(url, {method: 'HEAD', signal, redirect: 'error'});
  // Only an expired immutable lease can be reopened. Security/version failures
  // remain errors and can never fall through to an unverified full-file read.
  if (response.status === 410) response = await fetch(sessionUrl(url, null), {method: 'HEAD', signal, redirect: 'error'});
  if (!response.ok) throw new Error(`原 PDF 资源读取失败（${response.status}）。`);
  return response;
}

function inspectSession(response: Response, url: string, expectedSize: number): Session {
  const id = response.headers.get('x-roc-preview-session');
  if (response.headers.get('content-type') !== 'application/pdf' ||
      response.headers.get('accept-ranges') !== 'bytes' || id === null ||
      !/^[a-f0-9-]{36}$/u.test(id) || Number(response.headers.get('content-length')) !== expectedSize) {
    if (id !== null && /^[a-f0-9-]{36}$/u.test(id)) releaseSession({url: sessionUrl(url, id)});
    throw new Error('原 PDF 资源版本或读取协议不一致。');
  }
  return {url: sessionUrl(url, id), id, size: expectedSize};
}

function releaseSession(session: Pick<Session, 'url'>): void {
  const url = sourceUrl(session.url);
  url.searchParams.set('release', '1');
  // Best effort during native unload; Main also expires idle leases and enforces
  // a global descriptor/disk budget if Chromium cannot finish this request.
  void fetch(url, {method: 'HEAD', keepalive: true, redirect: 'error'}).catch(() => {});
}

export function releasePdfSource(value: string): void {
  let url: URL;
  try {url = sourceUrl(value);} catch {return;}
  const id = url.searchParams.get('session');
  if (id !== null && /^[a-f0-9-]{36}$/u.test(id)) releaseSession({url: url.href});
}

class VerifiedPdfTransport extends PDFDataRangeTransport {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly jobs: Job[] = [];
  private active = 0;
  private stopped = false;
  private renewing: Promise<void> | null = null;

  constructor(private session: Session, initial: Uint8Array<ArrayBuffer>, parentSignal: AbortSignal,
    private readonly failure: (error: unknown) => void) {
    super(session.size, initial, true);
    this.signal = AbortSignal.any([parentSignal, this.controller.signal]);
    this.signal.addEventListener('abort', () => this.abort(), {once: true});
    if (this.signal.aborted) this.abort();
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.stopped) return;
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end > this.length ||
        end <= begin || end - begin > maximumRequestBytes || this.jobs.length >= maximumQueuedRequests) {
      this.fail(new Error('原 PDF 单次读取超过预览预算。'));
      return;
    }
    this.jobs.push({begin, end});
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.active < maximumConcurrentRequests && this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      this.active++;
      void this.read(job).then(bytes => {
        if (!this.stopped) this.onDataRange(job.begin, bytes);
      }).catch(error => {if (!this.stopped) this.fail(error);}).finally(() => {
        this.active--; this.pump();
      });
    }
  }

  private async renew(): Promise<void> {
    this.renewing ??= (async () => {
      const response = await head(sessionUrl(this.session.url, null), this.signal);
      const next = inspectSession(response, this.session.url, this.length);
      if (this.signal.aborted) {
        releaseSession(next);
        this.signal.throwIfAborted();
      }
      this.session = next;
    })().finally(() => {this.renewing = null;});
    await this.renewing;
  }

  private async read(job: Job): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(job.end - job.begin);
    for (let begin = job.begin; begin < job.end; begin += wireRangeBytes) {
      this.signal.throwIfAborted();
      const end = Math.min(job.end, begin + wireRangeBytes);
      const options: RequestInit = {headers: {range: `bytes=${begin}-${end - 1}`}, signal: this.signal, redirect: 'error'};
      let response = await fetch(this.session.url, options);
      if (response.status === 410) {
        await this.renew();
        response = await fetch(this.session.url, options);
      }
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${begin}-${end - 1}/${this.length}` ||
          Number(response.headers.get('content-length')) !== end - begin ||
          response.headers.get('content-type') !== 'application/pdf') {
        await response.body?.cancel();
        throw new Error(`原 PDF 分段读取失败（${response.status}）。`);
      }
      bytes.set(await boundedBytes(response, end - begin), begin - job.begin);
    }
    return bytes;
  }

  private fail(error: unknown): void {
    this.abort(); this.failure(error);
  }

  override abort(): void {
    if (this.stopped) return;
    this.stopped = true; this.jobs.length = 0; this.controller.abort();
    releaseSession(this.session);
  }
}

/** Custom schemes do not enable PDF.js HTTP ranges; use its controlled transport. */
export async function openPdfSource(url: string, expectedSize: number, signal: AbortSignal,
  failure: (error: unknown) => void): Promise<PdfSource> {
  sourceUrl(url);
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new Error('原 PDF 资源大小无效。');
  if (expectedSize <= wireRangeBytes) {
    // One bounded response avoids a metadata round trip and the range transport
    // for small sources. Main still verifies the complete source and ownership.
    const small = await fetch(url, {signal, redirect: 'error'});
    const size = small.headers.get('content-length');
    if (!small.ok || small.headers.get('content-type') !== 'application/pdf' ||
        (size !== null && Number(size) !== expectedSize)) {
      await small.body?.cancel();
      throw new Error(`原 PDF 资源读取失败（${small.status}）。`);
    }
    try {
      return {data: await boundedBytes(small, expectedSize), dispose: () => releasePdfSource(url)};
    } catch (error) {
      releasePdfSource(url); throw error;
    }
  }
  const response = await head(url, signal);
  if (response.headers.get('accept-ranges') !== 'bytes' && response.headers.get('x-roc-preview-session') === null) {
    if (expectedSize > maximumLegacyBytes) throw new Error('此 PDF 超过兼容读取预算，请启用分段预览后重试。');
    const full = await fetch(url, {signal, redirect: 'error'});
    if (!full.ok) throw new Error(`原 PDF 资源读取失败（${full.status}）。`);
    return {data: await boundedBytes(full, expectedSize), dispose: () => {}};
  }
  const session = inspectSession(response, url, expectedSize);
  try {
    const end = Math.min(chunkBytes, expectedSize);
    const initial = await fetch(session.url, {headers: {range: `bytes=0-${end - 1}`}, signal, redirect: 'error'});
    if (initial.status !== 206 || initial.headers.get('content-range') !== `bytes 0-${end - 1}/${expectedSize}` ||
        Number(initial.headers.get('content-length')) !== end) {
      await initial.body?.cancel();
      throw new Error(`原 PDF 首段读取失败（${initial.status}）。`);
    }
    const transport = new VerifiedPdfTransport(session, await boundedBytes(initial, end), signal, failure);
    signal.throwIfAborted();
    return {range: transport, rangeChunkSize: chunkBytes, disableStream: true, disableAutoFetch: true,
      dispose: () => transport.abort()};
  } catch (error) {
    releaseSession(session); throw error;
  }
}
