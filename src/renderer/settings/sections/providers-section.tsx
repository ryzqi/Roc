import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type {
  ProviderConfig,
  ProviderModel,
  ProviderSecretStatus,
  ProviderTestResult
} from '../../../shared/types';
import { isFixedProvider, isFixedProviderType } from '../../../shared/provider-defaults';
import {
  providerTypeMeta,
  type CreatableProviderType,
  type ProviderDraft,
  type EditableProviderType,
  updateProviderModelCard
} from '../../settings-model';
import { ProviderModelOptionsFields } from './provider-model-options-fields';

function ModelCard({
  index,
  model,
  providerType,
  onChange,
  onDelete,
  onTest
}: {
  index: number;
  model: ProviderModel;
  providerType: EditableProviderType;
  onChange: (model: ProviderModel) => void;
  onDelete: () => void;
  onTest: (() => void) | null;
}): React.JSX.Element {
  return (
    <article className="provider-model-card" data-testid={`provider-model-card-${index}`}>
      <header className="provider-model-card__header">
        <strong>{model.displayName.trim() || model.id.trim() || `模型 ${index + 1}`}</strong>
        <div className="provider-model-card__actions">
          {onTest === null ? null : <button data-testid={`provider-model-test-${index}`} onClick={onTest} type="button">测试模型</button>}
          <button data-testid={`provider-model-delete-${index}`} onClick={onDelete} type="button">删除</button>
        </div>
      </header>
      <div className="form-grid provider-model-card__identity">
        <label className="field"><span>模型 ID</span><input data-testid={`provider-model-id-${index}`} onChange={(event) => onChange({ ...model, id: event.currentTarget.value })} value={model.id} /></label>
        <label className="field"><span>显示名</span><input data-testid={`provider-model-name-${index}`} onChange={(event) => onChange({ ...model, displayName: event.currentTarget.value })} value={model.displayName} /></label>
      </div>
      <div className="provider-model-capabilities">
        {([
          ['enabled', '启用'],
          ['supportsStreaming', '流式'],
          ['supportsToolCalls', '工具调用'],
          ['supportsImages', '图片输入']
        ] as const).map(([key, label]) => (
          <label key={key}><input checked={model[key]} onChange={(event) => onChange({ ...model, [key]: event.currentTarget.checked })} type="checkbox" />{label}</label>
        ))}
      </div>
      <ProviderModelOptionsFields
        index={index}
        onChange={(options) => onChange({ ...model, options })}
        options={model.options}
        providerType={providerType}
      />
    </article>
  );
}

function providerHasReadyModel(provider: ProviderConfig): boolean {
  return provider.enabled && provider.models.some((model) => model.enabled);
}

function findSecret(
  statuses: readonly ProviderSecretStatus[],
  providerId: string
): ProviderSecretStatus | null {
  return statuses.find((entry) => entry.providerId === providerId) ?? null;
}

function ProviderAvatar({ provider }: { provider: ProviderConfig | null }): React.JSX.Element {
  const fallback = '?';
  const seed = provider === null ? fallback : provider.name.trim().charAt(0).toUpperCase() || fallback;
  return <span className="provider-avatar">{seed}</span>;
}

export function ProvidersSection({
  draft,
  draftError,
  onClearProviderSecret,
  onDeleteProvider,
  onEditProvider,
  onSaveProviderDraft,
  onStartNewProvider,
  onTestProvider,
  onUpdateDraft,
  providers,
  providerSecretStatus,
  providerTestStatus,
  secretBusyProviderId
}: {
  draft: ProviderDraft;
  draftError: string | null;
  onClearProviderSecret: (providerId: string) => Promise<void>;
  onDeleteProvider: (providerId: string) => Promise<void>;
  onEditProvider: (provider: ProviderConfig) => void;
  onSaveProviderDraft: () => Promise<void>;
  onStartNewProvider: (type: CreatableProviderType) => void;
  onTestProvider: (providerId: string, modelId: string) => Promise<void>;
  onUpdateDraft: (partial: Partial<ProviderDraft>) => void;
  providers: ProviderConfig[];
  providerSecretStatus: ProviderSecretStatus[];
  providerTestStatus: ProviderTestResult | null;
  secretBusyProviderId: string | null;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const providerTypeOptions: Array<{ type: CreatableProviderType; label: string }> = [
    { type: 'openai_compatible', label: 'OpenAI-compatible' },
    { type: 'anthropic_compatible', label: 'Anthropic-compatible' }
  ];

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) {
      return providers;
    }
    return providers.filter((provider) =>
      provider.name.toLowerCase().includes(q) || provider.id.toLowerCase().includes(q)
    );
  }, [providers, search]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === draft.id) ?? null,
    [providers, draft.id]
  );
  const fixedProviderSelected = selectedProvider !== null && isFixedProvider(selectedProvider.id);
  const fixedProviderDraft = isFixedProviderType(draft.type);
  const fixedBaseUrlProviderDraft = draft.type === 'openrouter';
  const fixedEndpoint = draft.type === 'nvidia';

  const meta = providerTypeMeta(draft.type);
  const isCreating = draft.mode === 'create';
  const [revealApiKey, setRevealApiKey] = useState(false);
  const stored = selectedProvider === null
    ? false
    : findSecret(providerSecretStatus, selectedProvider.id)?.stored === true;
  const busy = secretBusyProviderId !== null && secretBusyProviderId === selectedProvider?.id;

  useEffect(() => {
    setRevealApiKey(false);
  }, [draft.id, draft.mode]);

  const runtimeStatus = (() => {
    if (selectedProvider === null) {
      return null;
    }
    if (providerTestStatus !== null && providerTestStatus.providerId === selectedProvider.id) {
      return providerTestStatus.status;
    }
    return providerHasReadyModel(selectedProvider) ? 'ready' : 'invalid';
  })();

  const testFeedback = useMemo(() => {
    if (selectedProvider === null) {
      return null;
    }
    if (providerTestStatus === null || providerTestStatus.providerId !== selectedProvider.id) {
      return null;
    }
    const latencySuffix =
      typeof providerTestStatus.latencyMs === 'number' && providerTestStatus.latencyMs >= 0
        ? `（耗时 ${providerTestStatus.latencyMs} ms）`
        : '';
    if (providerTestStatus.status === 'ready') {
      const base =
        providerTestStatus.modelId === null || providerTestStatus.modelId === undefined
          ? '已测试可用。'
          : `已测试 ${providerTestStatus.modelId} 可用。`;
      return {
        tone: 'ready' as const,
        text: `${base}${latencySuffix}`
      };
    }
    if (providerTestStatus.error === null) {
      const base =
        providerTestStatus.modelId === null || providerTestStatus.modelId === undefined
          ? '测试失败。'
          : `${providerTestStatus.modelId} 测试失败。`;
      return {
        tone: 'invalid' as const,
        text: `${base}${latencySuffix}`
      };
    }
    const base =
      providerTestStatus.modelId === null || providerTestStatus.modelId === undefined
        ? `测试失败：${providerTestStatus.error}`
        : `${providerTestStatus.modelId} 测试失败：${providerTestStatus.error}`;
    return {
      tone: 'invalid' as const,
      text: `${base}${latencySuffix}`
    };
  }, [providerTestStatus, selectedProvider]);

  return (
    <section className="single-panel provider-settings-card" data-testid="provider-settings">
      <div className="provider-toolbar">
        <input
          className="provider-search"
          data-testid="provider-search"
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="搜索提供商..."
          type="search"
          value={search}
        />
        <div className="provider-toolbar-actions">
          <button
            className="primary"
            data-testid="provider-add-openai"
            onClick={() => onStartNewProvider('openai_compatible')}
            type="button"
          >
            Add Custom Provider
          </button>
        </div>
      </div>
      <div className="provider-split">
        <aside className="provider-list" data-testid="provider-list">
          {filteredProviders.length === 0 ? (
            <div className="provider-list-empty">尚未配置 Provider</div>
          ) : (
            filteredProviders.map((provider) => {
              const ready = providerHasReadyModel(provider);
              const isActive = selectedProvider?.id === provider.id;
              return (
                <button
                  className={isActive ? 'provider-list-item active' : 'provider-list-item'}
                  data-testid={`provider-list-item-${provider.id}`}
                  key={provider.id}
                  onClick={() => onEditProvider(provider)}
                  type="button"
                >
                  <ProviderAvatar provider={provider} />
                  <span className="provider-list-name">{provider.name}</span>
                  <span className={`status-pill ${ready ? 'ok' : 'info'}`}>{ready ? '已就绪' : '未启用'}</span>
                </button>
              );
            })
          )}
        </aside>
        <div className="provider-detail" data-testid="provider-detail">
          <header className="provider-detail-header">
            <div className="provider-detail-title">
              <h3>{draft.name.trim().length === 0 ? (isCreating ? '新建 Provider' : draft.id) : draft.name}</h3>
              <span
                className={runtimeStatus === 'ready' ? 'provider-status-pill active' : 'provider-status-pill inactive'}
                data-testid="provider-detail-status"
              >
                {runtimeStatus === 'ready' ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className="provider-detail-controls">
              <label className="provider-detail-toggle">
                <input
                  checked={draft.enabled}
                  data-testid="provider-draft-enabled"
                  onChange={(event) => onUpdateDraft({ enabled: event.currentTarget.checked })}
                  type="checkbox"
                />
                <span className="provider-detail-toggle-track" aria-hidden="true">
                  <span className="provider-detail-toggle-thumb" />
                </span>
              </label>
            </div>
          </header>
          {testFeedback === null ? null : (
            <div
              className={
                testFeedback.tone === 'ready'
                  ? 'provider-test-feedback provider-test-feedback--ready'
                  : 'provider-test-feedback provider-test-feedback--invalid'
              }
              data-testid="provider-test-feedback"
            >
              {testFeedback.text}
            </div>
          )}
          {isCreating ? (
            <div className="provider-type-section">
              <span className="provider-detail-label">Provider 类型</span>
              <div className="provider-type-segmented" role="group" aria-label="Provider 类型">
                {providerTypeOptions.map((option) => {
                  const active = option.type === draft.type;
                  return (
                    <button
                      aria-pressed={active}
                      className={active ? 'provider-type-option active' : 'provider-type-option'}
                      data-testid={`provider-draft-type-${option.type}`}
                      key={option.type}
                      onClick={() => onUpdateDraft({ type: option.type })}
                      type="button"
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {fixedProviderDraft ? null : (
            <div className="form-grid">
              <label className="field">
                <span>名称</span>
                <input
                  data-testid="provider-draft-name"
                  onChange={(event) => onUpdateDraft({ name: event.currentTarget.value })}
                  placeholder="e.g. My OpenAI"
                  value={draft.name}
                />
              </label>
            </div>
          )}
          <label className="field">
            <span>API Key</span>
            <div className="provider-secret-input">
              <input
                autoComplete="off"
                data-testid="provider-draft-api-key"
                onChange={(event) => onUpdateDraft({ apiKey: event.currentTarget.value })}
                placeholder={stored ? '已有凭据。输入新值以替换' : 'Enter your API key'}
                type={revealApiKey ? 'text' : 'password'}
                value={draft.apiKey}
              />
              <button
                aria-label={revealApiKey ? '隐藏 API Key' : '显示 API Key'}
                aria-pressed={revealApiKey}
                className={revealApiKey ? 'provider-secret-toggle active' : 'provider-secret-toggle'}
                onClick={() => setRevealApiKey((current) => !current)}
                type="button"
              >
                {revealApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {selectedProvider === null || !stored ? null : (
              <div className="provider-secret-actions">
                <button
                  data-testid={`provider-secret-clear-${selectedProvider.id}`}
                  disabled={busy}
                  onClick={() => void onClearProviderSecret(selectedProvider.id)}
                  type="button"
                >
                  清除
                </button>
              </div>
            )}
          </label>
          {fixedBaseUrlProviderDraft ? null : (
            <label className="field">
              <span>{fixedEndpoint ? '固定端点' : 'Base URL'}</span>
              <input
                data-testid="provider-draft-endpoint"
                onChange={(event) => onUpdateDraft({ endpoint: event.currentTarget.value })}
                placeholder={meta.defaultBaseUrl}
                readOnly={fixedEndpoint}
                value={draft.endpoint}
              />
              <span className="field-hint">
                {draft.type === 'nvidia'
                  ? '留空使用 NVIDIA 官方 OpenAI-compatible 端点；自托管 NIM 可在高级参数中覆盖。'
                  : `留空将回退到默认 ${meta.defaultBaseUrl}`}
              </span>
            </label>
          )}
          <div className="provider-model-editor" data-testid="provider-model-editor">
            <div className="provider-model-editor__heading">
              <span>模型列表</span>
              <button
                data-testid="provider-model-add"
                onClick={() => onUpdateDraft({
                  models: [
                    ...draft.models,
                    {
                      id: '',
                      displayName: '',
                      enabled: true,
                      supportsStreaming: true,
                      supportsToolCalls: true,
                      supportsImages: false
                    }
                  ]
                })}
                type="button"
              >
                新增模型
              </button>
            </div>
            {draft.models.map((model, index) => (
              <ModelCard
                index={index}
                key={`${index}:${model.id}`}
                model={model}
                onChange={(next) => onUpdateDraft({ models: updateProviderModelCard(draft.models, index, next) })}
                onDelete={() => onUpdateDraft({ models: draft.models.filter((_, cardIndex) => cardIndex !== index) })}
                onTest={selectedProvider === null || model.id.trim().length === 0 ? null : () => void onTestProvider(selectedProvider.id, model.id)}
                providerType={draft.type}
              />
            ))}
          </div>
          <div className="provider-detail-connection-fields">
            <label className="field"><span>timeout_ms</span><input value={draft.timeoutMs} onChange={(event) => onUpdateDraft({ timeoutMs: event.currentTarget.value })} /></label>
            {draft.type === 'openai_compatible' ? <label className="field"><span>organization</span><input value={draft.organization} onChange={(event) => onUpdateDraft({ organization: event.currentTarget.value })} /></label> : null}
            <label className="field field--full"><span>default_headers</span><textarea rows={3} value={draft.defaultHeaders} onChange={(event) => onUpdateDraft({ defaultHeaders: event.currentTarget.value })} /></label>
            {draft.type === 'nvidia' ? <label className="field"><span>endpoint_override</span><input value={draft.endpointOverride} onChange={(event) => onUpdateDraft({ endpointOverride: event.currentTarget.value })} /></label> : null}
          </div>
          <div className="provider-detail-actions">
            <button data-testid="provider-save" onClick={() => void onSaveProviderDraft()} type="button">
              {fixedProviderDraft ? `保存 ${draft.name} 配置` : '保存 Provider'}
            </button>
            {selectedProvider === null || fixedProviderSelected ? null : (
              <button
                className="provider-detail-delete"
                data-testid={`provider-delete-${selectedProvider.id}`}
                onClick={() => void onDeleteProvider(selectedProvider.id)}
                type="button"
              >
                删除
              </button>
            )}
            {draftError === null ? null : (
              <span className="pill warn" data-testid="provider-draft-status">
                {draftError}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
