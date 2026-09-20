import type { ResearchEmbeddingConfig } from '../../../shared/types';

export function ResearchEmbeddingPanel({
  configs,
  id,
  name,
  baseUrl,
  model,
  dimensions,
  apiKey,
  working,
  onIdChange,
  onNameChange,
  onBaseUrlChange,
  onModelChange,
  onDimensionsChange,
  onApiKeyChange,
  onSave
}: {
  configs: ResearchEmbeddingConfig[];
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  dimensions: string;
  apiKey: string;
  working: boolean;
  onIdChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onDimensionsChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onSave: () => void;
}): React.JSX.Element {
  return (
    <section className="research-tool-panel" data-testid="research-embedding-panel">
      <div className="research-tool-heading">
        <div>
          <div className="research-section-label">Embedding Provider</div>
          <h2>嵌入模型配置</h2>
          <p>连接 OpenAI 兼容 Embeddings API。Key 只写入本地加密 Secret Store。</p>
        </div>
        <span className="research-config-count">{configs.length} 个配置</span>
      </div>
      <div className="research-config-grid">
        <label>配置 ID<input value={id} onChange={(event) => onIdChange(event.target.value)} /></label>
        <label>名称<input value={name} onChange={(event) => onNameChange(event.target.value)} /></label>
        <label className="research-config-wide">Base URL<input value={baseUrl} onChange={(event) => onBaseUrlChange(event.target.value)} /></label>
        <label>模型<input value={model} onChange={(event) => onModelChange(event.target.value)} /></label>
        <label>向量维度<input inputMode="numeric" value={dimensions} onChange={(event) => onDimensionsChange(event.target.value)} /></label>
        <label className="research-config-wide">API Key<input type="password" value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} placeholder="保存时写入 Secret Store" /></label>
      </div>
      <div className="research-form-actions">
        <button className="action-button action-button--primary" disabled={working} type="button" onClick={onSave}>保存配置</button>
      </div>
      <div className="research-config-list">
        {configs.map((config) => <div className="research-config-row" key={config.id}><strong>{config.name}</strong><span>{config.model} · {config.dimensions} 维 · {config.keyConfigured ? 'Key 已配置' : '缺少 Key'}</span></div>)}
      </div>
    </section>
  );
}
