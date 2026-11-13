import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {RocPluginContext} from '../../kernel/types';
import {rerankerSettingsSchema, rerankerSaveSchema, type RerankerSave, type RerankerReceipt} from '../../../shared/schemas/research-reranker';

const storageKey = 'research.reranker';
const storedSchema = rerankerSettingsSchema.extend({secretKey: z.string()});
const responseSchema = z.object({results: z.array(z.object({
  index: z.number().int().nonnegative(), relevance_score: z.number().finite().min(0).max(1)
}))});

/** Joint query/document scores from a dedicated rerank endpoint; no lexical substitute. */
export class ResearchRerankerService {
  constructor(private readonly context: Pick<RocPluginContext, 'config' | 'secrets' | 'logger'>,
    private readonly fetchImpl: typeof fetch = fetch) {}

  async readConfig() {
    const value = this.context.config.get<unknown>(storageKey);
    if (value === null) return null;
    const {secretKey, ...settings} = storedSchema.parse(value);
    let keyConfigured = false;
    try { keyConfigured = await this.context.secrets.get(secretKey) !== null; } catch {}
    return {...settings, keyConfigured};
  }

  async saveConfig(input: RerankerSave) {
    const {apiKey, ...settings} = rerankerSaveSchema.parse(input);
    const previous = this.context.config.get<unknown>(storageKey);
    const secretKey = `research.reranker.${randomUUID()}`;
    await this.context.secrets.set(secretKey, apiKey);
    try { this.context.config.set(storageKey, {...settings, secretKey}); }
    catch (error) { this.context.secrets.clear(secretKey); throw error; }
    if (previous !== null) this.context.secrets.clear(storedSchema.parse(previous).secretKey);
    return {...settings, keyConfigured: true};
  }

  async rank(query: string, documents: string[], external: AbortSignal): Promise<{scores: number[] | null; receipt: RerankerReceipt}> {
    external.throwIfAborted();
    const started = performance.now();
    const value = this.context.config.get<unknown>(storageKey);
    const config = value === null ? null : storedSchema.parse(value);
    const receipt = (status: RerankerReceipt['status']): RerankerReceipt => ({
      status, model: config?.model ?? null,
      configHash: config === null ? null : createHash('sha256').update(JSON.stringify(config)).digest('hex'),
      elapsedMs: performance.now() - started
    });
    if (config === null) return {scores: null, receipt: receipt('config_missing')};
    if (!config.enabled) return {scores: null, receipt: receipt('disabled')};
    if (documents.length === 0) return {scores: [], receipt: receipt('succeeded')};
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([external, timeout]);
    try {
      const apiKey = await this.context.secrets.get(config.secretKey);
      if (apiKey === null) return {scores: null, receipt: receipt('config_missing')};
      signal.throwIfAborted();
      const response = await this.fetchImpl(config.endpoint, {method: 'POST', signal,
        headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'},
        body: JSON.stringify({model: config.model, query, documents, top_n: documents.length})});
      if (!response.ok) { await response.body?.cancel(); throw new Error(`reranker_http_${response.status}`); }
      const {results} = responseSchema.parse(await response.json());
      signal.throwIfAborted();
      const scores = new Array<number>(documents.length);
      if (results.length !== documents.length) throw new Error('reranker_count_mismatch');
      for (const row of results) {
        if (row.index >= scores.length || scores[row.index] !== undefined) throw new Error('reranker_index_invalid');
        scores[row.index] = row.relevance_score;
      }
      return {scores, receipt: receipt('succeeded')};
    } catch {
      external.throwIfAborted();
      const status = timeout.aborted ? 'timeout' : 'failed';
      this.context.logger.warn('Semantic reranker fell back to RRF.', {status, model: config.model});
      return {scores: null, receipt: receipt(status)};
    }
  }
}
