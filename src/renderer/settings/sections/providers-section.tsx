import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type {
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult
} from '../../../shared/types';
import { isFixedProvider } from '../../../shared/provider-defaults';
import {
  providerTypeMeta,
  type CreatableProviderType,
  type ProviderDraft
} from '../../settings-model';

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

function ProviderSecretToggleIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path
        d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="12" fill="none" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function ProvidersSection({
  draft,
  draftError,
  onClearProviderSecret,
  onDeleteProvider,
  onEditProvider,
  onSaveProviderDraft,
  onSetProviderSecret,
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
  onSetProviderSecret: (providerId: string, plaintext: string) => Promise<void>;
  onStartNewProvider: (type: CreatableProviderType) => void;
  onTestProvider: (providerId: string) => Promise<void>;
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
    if (providerTestStatus.status === 'ready') {
      return {
        tone: 'ready' as const,
        text:
          providerTestStatus.modelId === null || providerTestStatus.modelId === undefined
            ? '已测试可用。'
            : `已测试 ${providerTestStatus.modelId} 可用。`
      };
    }
    if (providerTestStatus.error === null) {
      return {
        tone: 'invalid' as const,
        text:
          providerTestStatus.modelId === null || providerTestStatus.modelId === undefined
            ? '测试失败。'
            : `${providerTestStatus.modelId} 测试失败。`
      };
    }
    return {
      tone: 'invalid' as const,
      text:
        providerTestStatus.modelId === null || providerTestStatus.modelId === undefined
          ? `测试失败：${providerTestStatus.error}`
          : `${providerTestStatus.modelId} 测试失败：${providerTestStatus.error}`
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
              {selectedProvider === null ? null : (
                <button
                  className="provider-detail-test"
                  data-testid={`provider-test-${selectedProvider.id}`}
                  onClick={() => void onTestProvider(selectedProvider.id)}
                  title="测试 Provider"
                  type="button"
                  aria-label="测试 Provider"
                >
                  ⚡
                </button>
              )}
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
          {draft.type === 'nvidia' ? null : (
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
                <ProviderSecretToggleIcon />
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
          <label className="field">
            <span>{draft.type === 'nvidia' ? '固定端点' : 'Base URL'}</span>
            <input
              data-testid="provider-draft-endpoint"
              onChange={(event) => onUpdateDraft({ endpoint: event.currentTarget.value })}
              placeholder={meta.defaultBaseUrl}
              readOnly={draft.type === 'nvidia'}
              value={draft.endpoint}
            />
            <span className="field-hint">
              {draft.type === 'nvidia' ? 'NVIDIA Provider 固定使用官方 OpenAI-compatible 端点。' : `留空将回退到默认 ${meta.defaultBaseUrl}`}
            </span>
          </label>
          <label className="field">
            <span>模型列表</span>
            <textarea
              data-testid="provider-draft-models"
              onChange={(event) => onUpdateDraft({ modelsText: event.currentTarget.value })}
              placeholder="一行一个,格式:modelId | displayName"
              rows={4}
              value={draft.modelsText}
            />
          </label>
          {draft.type === 'nvidia' ? (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>Temperature</span>
                  <input
                    data-testid="provider-draft-temperature"
                    inputMode="decimal"
                    onChange={(event) => onUpdateDraft({ temperature: event.currentTarget.value })}
                    placeholder="1.0"
                    value={draft.temperature}
                  />
                </label>
                <label className="field">
                  <span>Max tokens</span>
                  <input
                    data-testid="provider-draft-max-tokens"
                    inputMode="numeric"
                    onChange={(event) => onUpdateDraft({ maxTokens: event.currentTarget.value })}
                    placeholder="16384"
                    value={draft.maxTokens}
                  />
                </label>
              </div>
              <label className="provider-detail-toggle provider-detail-toggle--inline">
                <input
                  checked={draft.thinking}
                  data-testid="provider-draft-thinking"
                  onChange={(event) => onUpdateDraft({ thinking: event.currentTarget.checked })}
                  type="checkbox"
                />
                <span className="provider-detail-toggle-track" aria-hidden="true">
                  <span className="provider-detail-toggle-thumb" />
                </span>
                <span>启用 thinking / reasoning</span>
              </label>
            </>
          ) : null}
          <div className="provider-detail-actions">
            <button data-testid="provider-save" onClick={() => void onSaveProviderDraft()} type="button">
              {draft.type === 'nvidia' ? '保存 NVIDIA 配置' : '保存 Provider'}
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
