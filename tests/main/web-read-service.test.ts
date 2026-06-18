import { describe, expect, it, vi } from 'vitest';
import { WebReadService } from '../../src/main/services/web-read-service';

describe('WebReadService', () => {
  it('reads public URLs through r.jina.ai and forwards Jina Reader headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Reader output body', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8'
        }
      })
    );
    const service = new WebReadService(fetchMock);

    const result = await service.read({
      url: 'https://example.com/docs',
      responseMode: 'readerlm-v2',
      timeoutSeconds: 9,
      noCache: true
    });

    expect(result).toBe('Reader output body');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/docs',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-No-Cache': 'true',
          'X-Respond-With': 'readerlm-v2',
          'X-Timeout': '9'
        })
      })
    );
  });

  it('rejects empty reader responses with an explicit domain error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('   ', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8'
        }
      })
    );
    const service = new WebReadService(fetchMock);

    await expect(
      service.read({
        url: 'https://example.com/empty'
      })
    ).rejects.toMatchObject({
      code: 'web_read_empty_response'
    });
  });

  it('falls back to markdown when readerlm-v2 returns unauthorized', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('Fallback markdown body', { status: 200 }));
    const service = new WebReadService(fetchMock);

    const result = await service.read({
      url: 'https://finance.sina.com.cn/nmetal/quotation.shtml',
      responseMode: 'readerlm-v2',
      timeoutSeconds: 10
    });

    expect(result).toBe('Fallback markdown body');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://r.jina.ai/https://finance.sina.com.cn/nmetal/quotation.shtml',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Respond-With': 'readerlm-v2',
          'X-Timeout': '10'
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://r.jina.ai/https://finance.sina.com.cn/nmetal/quotation.shtml',
      expect.objectContaining({
        headers: {
          'X-Respond-With': 'markdown',
          'X-Timeout': '10'
        }
      })
    );
  });

  it('accepts Jina Reader timeout values up to 180 seconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Reader output body', { status: 200 }));
    const service = new WebReadService(fetchMock);

    await service.read({
      url: 'https://example.com/slow',
      timeoutSeconds: 180
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/slow',
      expect.objectContaining({
        headers: {
          'X-Respond-With': 'markdown',
          'X-Timeout': '180'
        }
      })
    );
  });

  it('maps supported Jina Reader GET options to documented headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Reader output body', { status: 200 }));
    const service = new WebReadService(fetchMock);

    await service.read({
      url: 'https://example.com/docs',
      responseMode: 'frontmatter',
      timeoutSeconds: 30,
      cacheToleranceSeconds: 60,
      waitForSelector: ['main', '.quote'],
      targetSelector: 'article',
      removeSelector: ['nav', 'footer'],
      keepImgDataUrl: true,
      robotsTxt: 'Googlebot',
      doNotTrack: true,
      withGeneratedAlt: true,
      withImagesSummary: true,
      withLinksSummary: 'all',
      retainLinks: 'gpt-oss',
      retainImages: 'alt_p',
      retainMedia: 'html',
      preset: 'agent',
      withIframe: 'quoted',
      withShadowDom: true,
      engine: 'browser',
      locale: 'zh-CN',
      referer: 'https://example.com/source',
      tokenBudget: 2000,
      maxTokens: 1000,
      assertStatusCode: 200,
      respondTiming: 'network-idle',
      base: 'final',
      removeOverlay: false,
      detachInvisibles: true,
      markdownChunking: 's3',
      markdown: {
        headingStyle: 'atx',
        hr: '***',
        bulletListMarker: '-',
        emDelimiter: '_',
        strongDelimiter: '**',
        linkStyle: 'referenced',
        linkReferenceStyle: 'full'
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/docs',
      expect.objectContaining({
        headers: {
          DNT: '1',
          'X-Assert-Status-Code': '200',
          'X-Base': 'final',
          'X-Cache-Tolerance': '60',
          'X-Detach-Invisibles': 'true',
          'X-Engine': 'browser',
          'X-Keep-Img-Data-Url': 'true',
          'X-Locale': 'zh-CN',
          'X-Markdown-Chunking': 's3',
          'X-Max-Tokens': '1000',
          'X-Md-Bullet-List-Marker': '-',
          'X-Md-Em-Delimiter': '_',
          'X-Md-Heading-Style': 'atx',
          'X-Md-Hr': '***',
          'X-Md-Link-Reference-Style': 'full',
          'X-Md-Link-Style': 'referenced',
          'X-Md-Strong-Delimiter': '**',
          'X-Preset': 'agent',
          'X-Referer': 'https://example.com/source',
          'X-Remove-Overlay': 'false',
          'X-Remove-Selector': 'nav, footer',
          'X-Respond-Timing': 'network-idle',
          'X-Respond-With': 'frontmatter',
          'X-Retain-Images': 'alt_p',
          'X-Retain-Links': 'gpt-oss',
          'X-Retain-Media': 'html',
          'X-Robots-Txt': 'Googlebot',
          'X-Target-Selector': 'article',
          'X-Timeout': '30',
          'X-Token-Budget': '2000',
          'X-Wait-For-Selector': 'main, .quote',
          'X-With-Generated-Alt': 'true',
          'X-With-Iframe': 'quoted',
          'X-With-Images-Summary': 'true',
          'X-With-Links-Summary': 'all',
          'X-With-Shadow-Dom': 'true'
        }
      })
    );
  });

  it('does not send false values for Jina headers that parse any present value as true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Reader output body', { status: 200 }));
    const service = new WebReadService(fetchMock);

    await service.read({
      url: 'https://example.com/docs',
      keepImgDataUrl: false,
      withGeneratedAlt: false,
      withImagesSummary: false,
      withLinksSummary: false,
      withIframe: false,
      withShadowDom: false,
      removeOverlay: false,
      detachInvisibles: false
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({
      'X-Detach-Invisibles': 'false',
      'X-Remove-Overlay': 'false',
      'X-Respond-With': 'markdown',
      'X-Timeout': '20'
    });
  });
});
