import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { RocDomainError } from './errors';

export type WebReadResponseMode =
  | 'content'
  | 'markdown'
  | 'html'
  | 'text'
  | 'frontmatter'
  | 'readerlm-v2';
export type WebReadSelector = string | string[];
type WebReadEngine = 'auto' | 'browser' | 'curl' | 'cf-browser-rendering';
type WebReadRespondTiming =
  | 'html'
  | 'visible-content'
  | 'mutation-idle'
  | 'resource-idle'
  | 'media-idle'
  | 'network-idle';
type WebReadRetainLinks = 'none' | 'all' | 'text' | 'gpt-oss';
type WebReadRetainImages = 'none' | 'all' | 'alt' | 'all_p' | 'alt_p';
type WebReadRetainMedia = 'none' | 'text' | 'link' | 'image' | 'html';
type WebReadPreset = 'reader' | 'index' | 'research' | 'agent' | 'spider';
type WebReadBase = 'initial' | 'final';
type WebReadMarkdownChunking =
  | 'true'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'structured'
  | 's1'
  | 's2'
  | 's3'
  | 's4'
  | 's5';
type WebReadMarkdownOptions = {
  headingStyle?: 'setext' | 'atx';
  hr?: string;
  bulletListMarker?: '-' | '+' | '*';
  emDelimiter?: '_' | '*';
  strongDelimiter?: '**' | '__';
  linkStyle?: 'inlined' | 'referenced' | 'discarded';
  linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut' | 'discarded';
};
export type WebReadRequest = {
  url: string;
  responseMode?: WebReadResponseMode;
  timeoutSeconds?: number;
  noCache?: boolean;
  cacheToleranceSeconds?: number;
  waitForSelector?: WebReadSelector;
  targetSelector?: WebReadSelector;
  removeSelector?: WebReadSelector;
  keepImgDataUrl?: boolean;
  robotsTxt?: string;
  doNotTrack?: boolean;
  withGeneratedAlt?: boolean;
  withImagesSummary?: boolean;
  withLinksSummary?: boolean | 'all' | 'gpt-oss';
  retainLinks?: WebReadRetainLinks;
  retainImages?: WebReadRetainImages;
  retainMedia?: WebReadRetainMedia;
  preset?: WebReadPreset;
  withIframe?: boolean | 'quoted';
  withShadowDom?: boolean;
  engine?: WebReadEngine;
  locale?: string;
  referer?: string;
  tokenBudget?: number;
  maxTokens?: number;
  assertStatusCode?: number;
  respondTiming?: WebReadRespondTiming;
  base?: WebReadBase;
  removeOverlay?: boolean;
  detachInvisibles?: boolean;
  markdownChunking?: WebReadMarkdownChunking;
  markdown?: WebReadMarkdownOptions;
};

export type WebReadExecutionRequest = WebReadRequest & {
  signal?: AbortSignal;
};

export type WebReadResult = {
  content: string;
  source: string;
  proxy: 'https://r.jina.ai/';
  fetchedAt: string;
  contentHash: string;
  untrusted: true;
};

type FetchLike = typeof fetch;

const defaultTimeoutSeconds = 20;
const maxResponseBytes = 2 * 1024 * 1024;

export class WebReadService {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  async read(request: WebReadExecutionRequest): Promise<WebReadResult> {
    const targetUrl = this.requirePublicUrl(request.url);
    const responseMode = request.responseMode ?? 'markdown';
    const timeoutSeconds = this.normalizeTimeoutSeconds(request.timeoutSeconds);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(request.signal?.reason);
    if (isSignalAborted(request.signal)) {
      abortFromCaller();
    } else {
      request.signal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutSeconds * 1000);

    try {
      const response = await this.fetchReader(targetUrl, {
        request,
        responseMode,
        signal: controller.signal,
        timeoutSeconds
      });
      const finalResponse =
        response.status === 401 && responseMode === 'readerlm-v2'
          ? await this.fetchReader(targetUrl, {
              request,
              responseMode: 'markdown',
              signal: controller.signal,
              timeoutSeconds
            })
          : response;
      if (isSignalAborted(request.signal)) {
        throw createWebReadAbortedError();
      }
      if (!finalResponse.ok) {
        throw new RocDomainError({
          code: 'web_read_http_error',
          message: `web_read 请求失败：HTTP ${finalResponse.status}。`,
          category: 'external',
          retryable: finalResponse.status >= 500 || finalResponse.status === 429,
          userAction: '请稍后重试，或检查目标网址是否可公开访问。'
        });
      }

      const body = await this.readResponseBody(finalResponse);
      if (isSignalAborted(request.signal)) {
        throw createWebReadAbortedError();
      }
      if (body.trim().length === 0) {
        throw new RocDomainError({
          code: 'web_read_empty_response',
          message: 'web_read 未返回可读正文。',
          category: 'external',
          retryable: true,
          userAction: '请稍后重试，或换一个可公开访问的网址。'
        });
      }
      const contentHash = createHash('sha256').update(body, 'utf8').digest('hex');
      return {
        content: body,
        source: targetUrl.toString(),
        proxy: 'https://r.jina.ai/',
        fetchedAt: new Date().toISOString(),
        contentHash,
        untrusted: true
      };
    } catch (error) {
      if (error instanceof RocDomainError) {
        throw error;
      }
      if (isSignalAborted(request.signal)) {
        throw createWebReadAbortedError();
      }
      if (timedOut || this.isAbortError(error)) {
        throw new RocDomainError({
          code: 'web_read_timeout',
          message: 'web_read 请求超时。',
          category: 'external',
          retryable: true,
          userAction: '请缩小阅读范围、提高超时时间，或稍后重试。'
        });
      }
      if (error instanceof Error) {
        throw new RocDomainError({
          code: 'web_read_request_failed',
          message: `web_read 请求失败：${error.message}`,
          category: 'external',
          retryable: true,
          userAction: '请检查网络连接后重试。'
        });
      }
      throw new RocDomainError({
        code: 'web_read_request_failed',
        message: 'web_read 请求失败。',
        category: 'external',
        retryable: true,
        userAction: '请检查网络连接后重试。'
      });
    } finally {
      clearTimeout(timeoutId);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private buildHeaders(input: {
    responseMode: WebReadResponseMode;
    request: WebReadRequest;
    timeoutSeconds: number;
  }): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Respond-With': input.responseMode,
      'X-Timeout': String(input.timeoutSeconds)
    };
    const request = input.request;
    if (request.noCache === true) {
      headers['X-No-Cache'] = 'true';
    }
    this.setNumberHeader(headers, 'X-Cache-Tolerance', request.cacheToleranceSeconds);
    this.setSelectorHeader(headers, 'X-Wait-For-Selector', request.waitForSelector);
    this.setSelectorHeader(headers, 'X-Target-Selector', request.targetSelector);
    this.setSelectorHeader(headers, 'X-Remove-Selector', request.removeSelector);
    this.setTruthyBooleanHeader(headers, 'X-Keep-Img-Data-Url', request.keepImgDataUrl);
    this.setStringHeader(headers, 'X-Robots-Txt', request.robotsTxt);
    if (request.doNotTrack === true) {
      headers.DNT = '1';
    }
    this.setTruthyBooleanHeader(headers, 'X-With-Generated-Alt', request.withGeneratedAlt);
    this.setTruthyBooleanHeader(headers, 'X-With-Images-Summary', request.withImagesSummary);
    this.setTruthyBooleanOrStringHeader(headers, 'X-With-Links-Summary', request.withLinksSummary);
    this.setStringHeader(headers, 'X-Retain-Links', request.retainLinks);
    this.setStringHeader(headers, 'X-Retain-Images', request.retainImages);
    this.setStringHeader(headers, 'X-Retain-Media', request.retainMedia);
    this.setStringHeader(headers, 'X-Preset', request.preset);
    this.setTruthyBooleanOrStringHeader(headers, 'X-With-Iframe', request.withIframe);
    this.setTruthyBooleanHeader(headers, 'X-With-Shadow-Dom', request.withShadowDom);
    this.setStringHeader(headers, 'X-Engine', request.engine);
    this.setStringHeader(headers, 'X-Locale', request.locale);
    this.setStringHeader(headers, 'X-Referer', request.referer);
    this.setNumberHeader(headers, 'X-Token-Budget', request.tokenBudget);
    this.setNumberHeader(headers, 'X-Max-Tokens', request.maxTokens);
    this.setNumberHeader(headers, 'X-Assert-Status-Code', request.assertStatusCode);
    this.setStringHeader(headers, 'X-Respond-Timing', request.respondTiming);
    this.setStringHeader(headers, 'X-Base', request.base);
    this.setBooleanHeader(headers, 'X-Remove-Overlay', request.removeOverlay);
    this.setBooleanHeader(headers, 'X-Detach-Invisibles', request.detachInvisibles);
    this.setStringHeader(headers, 'X-Markdown-Chunking', request.markdownChunking);
    this.setStringHeader(headers, 'X-Md-Heading-Style', request.markdown?.headingStyle);
    this.setStringHeader(headers, 'X-Md-Hr', request.markdown?.hr);
    this.setStringHeader(headers, 'X-Md-Bullet-List-Marker', request.markdown?.bulletListMarker);
    this.setStringHeader(headers, 'X-Md-Em-Delimiter', request.markdown?.emDelimiter);
    this.setStringHeader(headers, 'X-Md-Strong-Delimiter', request.markdown?.strongDelimiter);
    this.setStringHeader(headers, 'X-Md-Link-Style', request.markdown?.linkStyle);
    this.setStringHeader(headers, 'X-Md-Link-Reference-Style', request.markdown?.linkReferenceStyle);
    return headers;
  }

  private async fetchReader(
    targetUrl: URL,
    input: {
      responseMode: WebReadResponseMode;
      request: WebReadRequest;
      timeoutSeconds: number;
      signal: AbortSignal;
    }
  ): Promise<Response> {
    const headers = this.buildHeaders(input);
    return await this.fetchImpl(`https://r.jina.ai/${targetUrl.toString()}`, {
      method: 'GET',
      headers,
      signal: input.signal
    });
  }

  private async readResponseBody(response: Response): Promise<string> {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number.parseInt(contentLength, 10) > maxResponseBytes) {
      throw new RocDomainError({
        code: 'web_read_response_too_large',
        message: 'web_read 响应超过本地大小上限。',
        category: 'external',
        retryable: false,
        userAction: '请使用更小的阅读范围。'
      });
    }
    if (response.body === null) {
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) {
        throw new RocDomainError({
          code: 'web_read_response_too_large',
          message: 'web_read 响应超过本地大小上限。',
          category: 'external',
          retryable: false,
          userAction: '请使用更小的阅读范围。'
        });
      }
      return body;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        total += next.value.byteLength;
        if (total > maxResponseBytes) {
          await reader.cancel();
          throw new RocDomainError({
            code: 'web_read_response_too_large',
            message: 'web_read 响应超过本地大小上限。',
            category: 'external',
            retryable: false,
            userAction: '请使用更小的阅读范围。'
          });
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder().decode(concatBytes(chunks, total));
  }

  private setStringHeader(headers: Record<string, string>, name: string, value: string | undefined): void {
    if (value !== undefined) {
      headers[name] = value;
    }
  }

  private setNumberHeader(headers: Record<string, string>, name: string, value: number | undefined): void {
    if (value !== undefined) {
      headers[name] = String(value);
    }
  }

  private setBooleanHeader(headers: Record<string, string>, name: string, value: boolean | undefined): void {
    if (value !== undefined) {
      headers[name] = value ? 'true' : 'false';
    }
  }

  private setTruthyBooleanHeader(headers: Record<string, string>, name: string, value: boolean | undefined): void {
    if (value === true) {
      headers[name] = 'true';
    }
  }

  private setTruthyBooleanOrStringHeader(
    headers: Record<string, string>,
    name: string,
    value: boolean | string | undefined
  ): void {
    if (value !== undefined && value !== false) {
      headers[name] = value === true ? 'true' : value;
    }
  }

  private setSelectorHeader(headers: Record<string, string>, name: string, value: WebReadSelector | undefined): void {
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  private requirePublicUrl(url: string): URL {
    const normalized = url.trim();
    if (normalized.length === 0) {
      throw new RocDomainError({
        code: 'web_read_url_empty',
        message: 'web_read url 不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请提供要读取的网页 URL。'
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new RocDomainError({
        code: 'web_read_url_invalid',
        message: 'web_read 只支持合法的 HTTP/HTTPS URL。',
        category: 'validation',
        retryable: false,
        userAction: '请提供合法的公开网页 URL。'
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new RocDomainError({
        code: 'web_read_url_invalid',
        message: 'web_read 只支持合法的 HTTP/HTTPS URL。',
        category: 'validation',
        retryable: false,
        userAction: '请提供合法的公开网页 URL。'
      });
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new RocDomainError({
        code: 'web_read_url_credentials',
        message: 'web_read 拒绝包含 credentials 的 URL。',
        category: 'validation',
        retryable: false,
        userAction: '请移除 URL 中的用户名和密码。'
      });
    }
    if (isPrivateOrLinkLocalHost(parsed.hostname)) {
      throw new RocDomainError({
        code: 'web_read_private_url',
        message: 'web_read 只允许公开网络地址。',
        category: 'validation',
        retryable: false,
        userAction: '请提供公开可访问的网址。'
      });
    }
    return parsed;
  }

  private normalizeTimeoutSeconds(value: number | undefined): number {
    if (value === undefined) {
      return defaultTimeoutSeconds;
    }
    if (!Number.isInteger(value) || value <= 0 || value > 180) {
      throw new RocDomainError({
        code: 'web_read_timeout_invalid',
        message: 'web_read timeoutSeconds 必须是 1 到 180 之间的整数。',
        category: 'validation',
        retryable: false,
        userAction: '请提供 1 到 180 秒之间的超时时间。'
      });
    }
    return value;
  }

  private isAbortError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const record = error as { name?: unknown; code?: unknown };
    return record.name === 'AbortError' || record.code === 'ABORT_ERR';
  }
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isPrivateOrLinkLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === 'localhost.localdomain' || host === '::1') {
    return true;
  }
  const octets = host.split('.').map((part) => Number.parseInt(part, 10));
  if (isIP(host) === 4 && octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [first, second] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  if (isIP(host) === 6) {
    const normalized = host.split('%', 1)[0];
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith('::ffff:0.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:169.254.') ||
      normalized.startsWith('::ffff:192.168.')
    );
  }
  return host.endsWith('.localhost') || host.endsWith('.local');
}

function createWebReadAbortedError(): RocDomainError {
  return new RocDomainError({
    code: 'web_read_aborted',
    message: 'web_read 已取消。',
    category: 'external',
    retryable: false,
    userAction: '请重新发起读取。'
  });
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}
