import type { ResearchEmbeddingConfig } from '../../../shared/types';

export type EmbeddingFetch = (input: string, init: RequestInit) => Promise<Response>;

export class OpenAICompatibleEmbeddingClient {
  constructor(private readonly fetchImpl: EmbeddingFetch = (input, init) => fetch(input, init)) {}

  async embed(input: {
    config: ResearchEmbeddingConfig;
    apiKey: string;
    texts: readonly string[];
  }): Promise<number[][]> {
    if (input.texts.length === 0) {
      return [];
    }
    const endpoint = input.config.baseUrl.replace(/\/+$/u, '').endsWith('/embeddings')
      ? input.config.baseUrl.replace(/\/+$/u, '')
      : `${input.config.baseUrl.replace(/\/+$/u, '')}/embeddings`;
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: input.config.model, input: input.texts })
    });
    if (!response.ok) {
      throw new Error(`embedding_provider_http_${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const rows = parseEmbeddingResponse(payload);
    if (rows.length !== input.texts.length) {
      throw new Error('embedding_provider_count_mismatch');
    }
    for (const vector of rows) {
      if (vector.length !== input.config.dimensions || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('embedding_provider_dimensions_mismatch');
      }
    }
    return rows;
  }
}

function parseEmbeddingResponse(payload: unknown): number[][] {
  if (typeof payload !== 'object' || payload === null || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new Error('embedding_provider_response_invalid');
  }
  const rows = payload.data as unknown[];
  return rows
    .map((row, fallbackIndex) => {
      if (typeof row !== 'object' || row === null || !('embedding' in row) || !Array.isArray(row.embedding)) {
        throw new Error('embedding_provider_item_invalid');
      }
      const index = 'index' in row && typeof row.index === 'number' ? row.index : fallbackIndex;
      return { index, embedding: row.embedding.filter((value): value is number => typeof value === 'number') };
    })
    .sort((left, right) => left.index - right.index)
    .map((row) => row.embedding);
}

export function vectorToBlob(vector: readonly number[]): Buffer {
  const values = new Float32Array(vector);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}
