import { describe, expect, it } from 'vitest';

import { OpenAICompatibleEmbeddingClient } from '../../../../src/main/plugins/research/embedding-client';
import { LiteratureSearchService } from '../../../../src/main/plugins/research/literature-service';

describe('research adapters', () => {
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

