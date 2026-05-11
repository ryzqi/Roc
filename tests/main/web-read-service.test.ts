import { describe, expect, it, vi } from 'vitest';
import { WebReadService } from '../../src/main/services/web-read-service';

describe('WebReadService', () => {
  it('reads public URLs through r.jina.ai and forwards response mode plus no-cache headers', async () => {
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
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'x-respond-with': 'readerlm-v2'
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
});
