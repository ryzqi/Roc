import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

import { OpenAICompatibleEmbeddingClient } from '../../../../src/main/plugins/research/embedding-client';
import { vectorToBlob } from '../../../../src/main/plugins/research/embedding-vectors';
import { LiteratureSearchService } from '../../../../src/main/plugins/research/literature-service';

describe('research adapters', () => {
  it('sends float embeddings over HTTP and aborts a pending transport', async () => {
    let hold = false;
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
    const server = createServer((request, result) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (hold) { entered(); return; }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { encoding_format: string };
        result.writeHead(200, { 'content-type': 'application/json' });
        result.end(JSON.stringify({ data: [{ index: 0, embedding: payload.encoding_format === 'float' ? [1, 0, 0] : [0, 0, 0] }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server_address_required');
      const client = new OpenAICompatibleEmbeddingClient();
      const input = { config: { id: 'local', name: 'Local', baseUrl: `http://127.0.0.1:${address.port}`, model: 'test', dimensions: 3,
        keyConfigured: true, enabled: true, updatedAt: '2026-09-12T00:00:00.000Z' }, apiKey: 'sample-key', texts: ['Text'] };
      expect(await client.embed(input)).toEqual([[1, 0, 0]]);
      hold = true;
      const controller = new AbortController();
      const pending = client.embed({ ...input, signal: controller.signal });
      await requestEntered;
      controller.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects missing, duplicate, fractional and out-of-range embedding indexes', async () => {
    const cases = [
      [{ embedding: [1, 0, 0] }], [{ index: 0.5, embedding: [1, 0, 0] }], [{ index: 1, embedding: [1, 0, 0] }],
      [{ index: 0, embedding: [1, 0, 0] }, { index: 0, embedding: [0, 1, 0] }]
    ];
    for (const data of cases) {
      const client = new OpenAICompatibleEmbeddingClient(async () => Response.json({ data }));
      await expect(client.embed({ config: { id: 'test', name: 'Test', baseUrl: 'https://embedding.test/v1', model: 'test', dimensions: 3,
        keyConfigured: true, enabled: true, updatedAt: '2026-09-12T00:00:00.000Z' }, apiKey: 'sample-key', texts: data.map(() => 'text') })).rejects.toThrow('embedding_provider_');
    }
  });

  it('rejects invalid coordinates without dropping them or overflowing float32 storage', async () => {
    const client = new OpenAICompatibleEmbeddingClient(async () => Response.json({ data: [{ index: 0, embedding: [1, 'invalid', 0, 0] }] }));
    await expect(client.embed({ config: { id: 'test', name: 'Test', baseUrl: 'https://embedding.test/v1', model: 'test', dimensions: 3,
      keyConfigured: true, enabled: true, updatedAt: '2026-09-12T00:00:00.000Z' }, apiKey: 'sample-key', texts: ['text'] })).rejects.toThrow('embedding_provider_');
    expect(() => vectorToBlob([Number.POSITIVE_INFINITY, 0, 1])).toThrow('embedding_vector_invalid');
    expect(() => vectorToBlob([0, 0, 0])).toThrow('embedding_vector_invalid');
  });

  it('preserves embedding response indexes and validates configured dimensions', async () => {
    const client = new OpenAICompatibleEmbeddingClient(async (url, init) => {
      expect(url).toBe('https://embedding.test/v1/embeddings');
      expect(init.method).toBe('POST');
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    await expect(
      client.embed({
        config: {
          id: 'test',
          name: 'Test',
          baseUrl: 'https://embedding.test/v1',
          model: 'embed-test',
          dimensions: 3,
          keyConfigured: true,
          enabled: true,
          updatedAt: '2026-09-10T00:00:00.000Z'
        },
        apiKey: 'test-key',
        texts: ['first', 'second']
      })
    ).resolves.toEqual([[1, 0, 0], [0, 1, 0]]);
  });

  it('normalizes OpenAlex JSON and arXiv Atom into literature records', async () => {
    const service = new LiteratureSearchService(async (url) => {
      if (url.startsWith('https://api.openalex.org')) {
        return new Response(
          JSON.stringify({
            results: [{
              id: 'https://openalex.org/W1',
              doi: 'https://doi.org/10.1000/test',
              title: 'Evidence graph',
              authorships: [{ author: { display_name: 'Ada Researcher' } }],
              abstract_inverted_index: { evidence: [0], graph: [1] },
              publication_year: 2024,
              cited_by_count: 12,
              open_access: { oa_url: 'https://example.test/paper.pdf' }
            }]
          }),
          { status: 200 }
        );
      }
      return new Response(
        `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/1234.1</id><title>  A figure  </title><summary> A reproducible figure </summary><published>2023-01-01T00:00:00Z</published><author><name>Grace Analyst</name></author></entry></feed>`,
        { status: 200 }
      );
    });

    const records = await service.search({ query: 'evidence', sources: ['openalex', 'arxiv'], limit: 10 });

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'openalex', doi: '10.1000/test', title: 'Evidence graph', publishedYear: 2024 }),
      expect.objectContaining({ source: 'arxiv', title: 'A figure', publishedYear: 2023 })
    ]));
  });
});
