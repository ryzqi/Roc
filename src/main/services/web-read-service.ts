import { RocDomainError } from './errors';

export type WebReadResponseMode = 'markdown' | 'readerlm-v2';
export type WebReadRequest = {
  url: string;
  responseMode?: WebReadResponseMode;
  timeoutSeconds?: number;
  noCache?: boolean;
};

type FetchLike = typeof fetch;

const defaultTimeoutSeconds = 20;

export class WebReadService {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  async read(request: WebReadRequest): Promise<string> {
    const targetUrl = this.requirePublicUrl(request.url);
    const responseMode = request.responseMode ?? 'markdown';
    const timeoutSeconds = this.normalizeTimeoutSeconds(request.timeoutSeconds);
    const headers = this.buildHeaders(responseMode, request.noCache === true);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    try {
      const response = await this.fetchImpl(`https://r.jina.ai/${targetUrl.toString()}`, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new RocDomainError({
          code: 'web_read_http_error',
          message: `web_read 请求失败：HTTP ${response.status}。`,
          category: 'external',
          retryable: response.status >= 500 || response.status === 429,
          userAction: '请稍后重试，或检查目标网址是否可公开访问。'
        });
      }

      const body = await response.text();
      if (body.trim().length === 0) {
        throw new RocDomainError({
          code: 'web_read_empty_response',
          message: 'web_read 未返回可读正文。',
          category: 'external',
          retryable: true,
          userAction: '请稍后重试，或换一个可公开访问的网址。'
        });
      }
      return body;
    } catch (error) {
      if (error instanceof RocDomainError) {
        throw error;
      }
      if (this.isAbortError(error)) {
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
    }
  }

  private buildHeaders(responseMode: WebReadResponseMode, noCache: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (responseMode === 'readerlm-v2') {
      headers['x-respond-with'] = 'readerlm-v2';
    }
    if (noCache) {
      headers['cache-control'] = 'no-cache';
      headers.pragma = 'no-cache';
    }
    return headers;
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
    return parsed;
  }

  private normalizeTimeoutSeconds(value: number | undefined): number {
    if (value === undefined) {
      return defaultTimeoutSeconds;
    }
    if (!Number.isInteger(value) || value <= 0 || value > 120) {
      throw new RocDomainError({
        code: 'web_read_timeout_invalid',
        message: 'web_read timeoutSeconds 必须是 1 到 120 之间的整数。',
        category: 'validation',
        retryable: false,
        userAction: '请提供 1 到 120 秒之间的超时时间。'
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
