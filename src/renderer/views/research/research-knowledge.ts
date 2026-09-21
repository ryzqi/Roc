import type {
  ResearchEmbeddingConfig,
  ResearchEvidence,
  ResearchKnowledgeSearchResult
} from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { createProjectionController } from './research-projection';

export type ResearchKnowledgeAdapter = {
  search(request: { query: string; projectId: string | null; limit: number; embeddingConfigId: null }): Promise<ResearchKnowledgeSearchResult>;
  listEvidence(request: { projectId: string }): Promise<ResearchEvidence[]>;
  captureEvidence(request: { projectId: string; chunkId: string }): Promise<unknown>;
  listEmbeddingConfigs(): Promise<ResearchEmbeddingConfig[]>;
  saveEmbeddingConfig(request: {
    id: string;
    name: string;
    baseUrl: string;
    model: string;
    dimensions: number;
    apiKey: string;
    enabled: true;
  }): Promise<ResearchEmbeddingConfig>;
};

export type ResearchKnowledgeSnapshot = {
  query: string;
  result: ResearchKnowledgeSearchResult | null;
  evidence: ResearchEvidence[];
  embedding: {
    configs: ResearchEmbeddingConfig[];
    id: string;
    name: string;
    baseUrl: string;
    model: string;
    dimensions: string;
    apiKey: string;
  };
  working: boolean;
  error: string | null;
};

export type ResearchKnowledgeProjection = {
  getSnapshot(): ResearchKnowledgeSnapshot;
  subscribe(listener: (snapshot: ResearchKnowledgeSnapshot) => void): () => void;
  setProject(projectId: string | null): void;
  setQuery(value: string): void;
  setEmbeddingField(field: 'id' | 'name' | 'baseUrl' | 'model' | 'dimensions' | 'apiKey', value: string): void;
  loadEvidence(): Promise<void>;
  search(): Promise<void>;
  capture(chunkId: string): Promise<void>;
  loadEmbeddingConfigs(): Promise<void>;
  saveEmbeddingConfig(): Promise<void>;
  clearError(): void;
};

const emptyEmbedding = {
  configs: [] as ResearchEmbeddingConfig[],
  id: 'default',
  name: '默认嵌入模型',
  baseUrl: 'https://api.openai.com/v1',
  model: 'text-embedding-3-small',
  dimensions: '1536',
  apiKey: ''
};

const emptySnapshot = (): ResearchKnowledgeSnapshot => ({
  query: '',
  result: null,
  evidence: [],
  embedding: { ...emptyEmbedding, configs: [] },
  working: false,
  error: null
});

export function createResearchKnowledgeProjection(adapter: ResearchKnowledgeAdapter): ResearchKnowledgeProjection {
  const projection = createProjectionController<ResearchKnowledgeSnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return {
        ...value,
        evidence: [...value.evidence],
        embedding: { ...value.embedding, configs: [...value.embedding.configs] }
      };
    }
  });
  let projectId: string | null = null;

  async function loadEvidence(token: number): Promise<void> {
    if (projectId === null) {
      if (!projection.isCurrent(token)) return;
      projection.assign({ evidence: [] });
      return;
    }
    const currentProjectId = projectId;
    const evidence = await adapter.listEvidence({ projectId: currentProjectId });
    if (!projection.isCurrent(token) || projectId !== currentProjectId) return;
    projection.assign({ evidence });
  }

  return {
    getSnapshot() { return projection.getSnapshot(); },
    subscribe(listener) { return projection.subscribe(listener); },
    setProject(next) {
      projectId = next;
    },
    setQuery(value) { projection.assign({ query: value }); },
    setEmbeddingField(field, value) {
      projection.assign({ embedding: { ...projection.peek().embedding, [field]: value } });
    },
    async loadEvidence() {
      const token = projection.bump();
      try {
        await loadEvidence(token);
      } catch (error) {
        if (!projection.isCurrent(token)) return;
        projection.fail(error instanceof Error ? error.message : '证据加载失败。');
      }
    },
    async search() {
      const query = projection.peek().query.trim();
      if (query.length === 0) return;
      await projection.runExclusive(async (token) => {
        const result = await adapter.search({ query, projectId, limit: 20, embeddingConfigId: null });
        if (!projection.isCurrent(token)) return;
        projection.assign({ result });
      }, { busy: '当前命令仍在进行。', failed: '知识库检索失败。' });
    },
    async capture(chunkId) {
      if (projectId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.captureEvidence({ projectId: currentProjectId, chunkId });
        if (!projection.isCurrent(token)) return;
        await loadEvidence(token);
      }, { busy: '当前命令仍在进行。', failed: '证据捕获失败。' });
    },
    async loadEmbeddingConfigs() {
      await projection.runExclusive(async (token) => {
        const configs = await adapter.listEmbeddingConfigs();
        if (!projection.isCurrent(token)) return;
        const active = configs.find((config) => config.enabled) ?? configs[0];
        projection.assign({
          embedding: {
            ...projection.peek().embedding,
            configs,
            ...(active === undefined ? {} : {
              id: active.id,
              name: active.name,
              baseUrl: active.baseUrl,
              model: active.model,
              dimensions: String(active.dimensions)
            })
          }
        });
      }, { busy: '当前命令仍在进行。', failed: '嵌入配置读取失败。' });
    },
    async saveEmbeddingConfig() {
      const embedding = projection.peek().embedding;
      const dimensions = Number(embedding.dimensions);
      if (!Number.isInteger(dimensions) || dimensions <= 0 || embedding.apiKey.trim().length === 0) {
        projection.fail('嵌入维度必须为正整数，接口密钥不能为空。');
        return;
      }
      await projection.runExclusive(async (token) => {
        const config = await adapter.saveEmbeddingConfig({
          id: embedding.id.trim(),
          name: embedding.name.trim(),
          baseUrl: embedding.baseUrl.trim(),
          model: embedding.model.trim(),
          dimensions,
          apiKey: embedding.apiKey.trim(),
          enabled: true
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({
          embedding: {
            ...projection.peek().embedding,
            configs: [config, ...projection.peek().embedding.configs.filter((item) => item.id !== config.id)],
            apiKey: ''
          }
        });
      }, { busy: '当前命令仍在进行。', failed: '嵌入配置保存失败。' });
    },
    clearError() { projection.clearError(); }
  };
}

export function createResearchKnowledgeAdapter(client: RocClient): ResearchKnowledgeAdapter {
  const research = client.api.research;
  return {
    async search(request) { return unwrap('知识库检索', await research.searchKnowledge(request)); },
    async listEvidence(request) { return unwrap('证据', await research.listEvidence(request)); },
    async captureEvidence(request) { return unwrap('捕获证据', await research.captureEvidence(request)); },
    async listEmbeddingConfigs() { return unwrap('嵌入配置', await research.listEmbeddingConfigs()); },
    async saveEmbeddingConfig(request) { return unwrap('保存嵌入配置', await research.saveEmbeddingConfig(request)); }
  };
}
