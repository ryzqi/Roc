import type { ResearchEmbeddingConfig } from '../../../shared/types';
import { vectorToBlob } from './embedding-vectors';

export type EmbeddingFetch = (input: string, init: RequestInit) => Promise<Response>;

export class OpenAICompatibleEmbeddingClient {
  constructor(private readonly fetchImpl: EmbeddingFetch = (input, init) => fetch(input, init)) {}

  /**
   * 探一次真实向量，读回它的长度（P10：维度自动探测）。
   *
   * 嵌入维度不是元数据，它只能从一次真实响应里量出来：`text-embedding-3-small` 可以是
   * 1536 或（截断后的）更小值，自建 bge / m3e 更是随部署而变。用户手填维度而猜错，失败会
   * 发生在「索引跑到一半」——所以这里用一条短文本换一个准确数字。
   *
   * 不复用 `embed()`：那条路径会把长度与 `config.dimensions` 比对，而这里的目的正是
   * 在还不知道维度时去量它。
   */
  async probeDimensions(input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    signal?: AbortSignal;
  }): Promise<number> {
    const rows = await this.requestVectors({ ...input, texts: ['dimension probe'] });
    const first = rows[0];
    if (first === undefined || first.length === 0) {
      throw new Error('embedding_provider_dimensions_unknown');
    }
    return first.length;
  }

  async embed(input: {
    config: ResearchEmbeddingConfig;
    apiKey: string;
    texts: readonly string[];
    signal?: AbortSignal;
  }): Promise<number[][]> {
    if (input.texts.length === 0) {
      return [];
    }
    const rows = await this.requestVectors({
      baseUrl: input.config.baseUrl,
      model: input.config.model,
      apiKey: input.apiKey,
      texts: input.texts,
      signal: input.signal
    });
    if (rows.length !== input.texts.length) {
      throw new Error('embedding_provider_count_mismatch');
    }
    for (const vector of rows) {
      if (vector.length !== input.config.dimensions || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('embedding_provider_dimensions_mismatch');
      }
      vectorToBlob(vector);
    }
    return rows;
  }

  private async requestVectors(input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    texts: readonly string[];
    signal?: AbortSignal;
  }): Promise<number[][]> {
    const endpoint = input.baseUrl.replace(/\/+$/u, '').endsWith('/embeddings')
      ? input.baseUrl.replace(/\/+$/u, '')
      : `${input.baseUrl.replace(/\/+$/u, '')}/embeddings`;
    const signal = input.signal === undefined ? AbortSignal.timeout(60_000) : AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: input.model, input: input.texts, encoding_format: 'float' }), signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`embedding_provider_http_${response.status}`);
    }
    const payload = await readPayload(response, signal);
    return parseEmbeddingResponse(payload);
  }
}

function parseEmbeddingResponse(payload: unknown): number[][] {
  if (typeof payload !== 'object' || payload === null || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new Error('embedding_provider_response_invalid');
  }
  const rows = payload.data as unknown[];
  return rows
    .map((row) => {
      if (typeof row !== 'object' || row === null || !('embedding' in row) || !Array.isArray(row.embedding)) {
        throw new Error('embedding_provider_item_invalid');
      }
      if (!('index' in row) || typeof row.index !== 'number' || !Number.isInteger(row.index) || row.index < 0 || row.index >= rows.length) {
        throw new Error('embedding_provider_index_invalid');
      }
      const values: unknown[] = row.embedding;
      if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) throw new Error('embedding_provider_vector_invalid');
      return { index: row.index, embedding: values };
    })
    .sort((left, right) => left.index - right.index)
    .map((row, index) => {
      if (row.index !== index) throw new Error('embedding_provider_index_invalid');
      return row.embedding;
    });
}

async function readPayload(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw new Error('embedding_provider_response_invalid');
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 32 * 1024 * 1024) throw new Error('embedding_provider_response_too_large');
      buffers.push(next.value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown;
  } finally { await reader.cancel(); }
}
