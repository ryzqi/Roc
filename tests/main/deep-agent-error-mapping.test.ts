import { describe, expect, it } from 'vitest';
import { RocDomainError } from '../../src/main/services/errors';
import { toRunFailure } from '../../src/main/services/deep-agent/error-mapping';

describe('deep agent error mapping', () => {
  it('keeps web_read domain failures instead of re-labeling them as provider network errors', () => {
    const error = new RocDomainError({
      code: 'web_read_request_failed',
      message: 'web_read 请求失败：fetch failed',
      category: 'external',
      retryable: true,
      userAction: '请检查网络连接后重试。'
    });

    expect(toRunFailure(error)).toEqual({
      code: 'web_read_request_failed',
      message: 'web_read 请求失败：fetch failed',
      retryable: true
    });
  });

  it('keeps web_read tool failure text out of provider network error relabeling for plain errors', () => {
    expect(toRunFailure(new Error('web_read 请求失败：fetch failed'))).toEqual({
      code: 'web_read_request_failed',
      message: 'web_read 请求失败：fetch failed',
      retryable: true
    });
  });

  it('preserves non-retryable web_read http failures for plain errors', () => {
    expect(toRunFailure(new Error('web_read 请求失败：HTTP 404。'))).toEqual({
      code: 'web_read_http_error',
      message: 'web_read 请求失败：HTTP 404。',
      retryable: false
    });
  });

  it('preserves web_read empty-response failures for plain errors', () => {
    expect(toRunFailure(new Error('web_read 未返回可读正文。'))).toEqual({
      code: 'web_read_empty_response',
      message: 'web_read 未返回可读正文。',
      retryable: true
    });
  });

  it('preserves web_read validation failures for plain errors', () => {
    expect(toRunFailure(new Error('web_read 只支持合法的 HTTP/HTTPS URL。'))).toEqual({
      code: 'web_read_url_invalid',
      message: 'web_read 只支持合法的 HTTP/HTTPS URL。',
      retryable: false
    });
    expect(toRunFailure(new Error('web_read timeoutSeconds 必须是 1 到 120 之间的整数。'))).toEqual({
      code: 'web_read_timeout_invalid',
      message: 'web_read timeoutSeconds 必须是 1 到 120 之间的整数。',
      retryable: false
    });
  });

  it('preserves web_search unavailable fallback text for plain errors', () => {
    expect(toRunFailure(new Error('web_search 当前不可用。'))).toEqual({
      code: 'web_search_unavailable',
      message: 'web_search 当前不可用。',
      retryable: true
    });
  });

  it('keeps web_read http 408 and 425 non-retryable for plain errors to match WebReadService', () => {
    expect(toRunFailure(new Error('web_read 请求失败：HTTP 408。'))).toEqual({
      code: 'web_read_http_error',
      message: 'web_read 请求失败：HTTP 408。',
      retryable: false
    });
    expect(toRunFailure(new Error('web_read 请求失败：HTTP 425。'))).toEqual({
      code: 'web_read_http_error',
      message: 'web_read 请求失败：HTTP 425。',
      retryable: false
    });
  });
});
