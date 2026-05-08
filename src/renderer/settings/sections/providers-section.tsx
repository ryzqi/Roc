import { useMemo, useState } from 'react';
import type React from 'react';
import type {
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult
} from '../../../shared/types';
import {
  providerTypeMeta,
  type EditableProviderType,
  type ProviderDraft
} from '../../settings-model';

function providerTypeLabel(type: ProviderConfig['type']): string {
  if (type === 'openai_compatible') {
    return 'OpenAI-compatible Provider';
  }
  if (type === 'anthropic_compatible') {
    return 'Anthropic-compatible Provider';
  }
  if (type === 'ollama') {
    return 'Ollama';
  }
  return 'Custom Endpoint';
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

function ProviderSecretEditor({
  busy,
  onClear,
  onSave,
  providerId,
  stored
}: {
  busy: boolean;
  onClear: () => Promise<void>;
  onSave: (plaintext: string) => Promise<void>;
  providerId: string;
  stored: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="provider-secret-editor">
      <div className="provider-secret-input">
        <input
          autoComplete="off"
          data-testid={`provider-secret-input-${providerId}`}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          placeholder={stored ? '已有凭据。输入新值以替换' : 'Enter your API key'}
          type={reveal ? 'text' : 'password'}
          value={value}
        />
        <button
          className="provider-secret-toggle"
          aria-label={reveal ? '隐藏 API Key' : '显示 API Key'}
          onClick={() => setReveal((current) => !current)}
          type="button"
        >
          {reveal ? '隐藏' : '显示'}
        </button>
      </div>
      <div className="provider-secret-actions">
        <button
          data-testid={`provider-secret-save-${providerId}`}
          disabled={busy || value.length === 0}
          onClick={async () => {
            try {
              await onSave(value);
              setValue('');
              setError(null);
            } catch (saveError) {
              setError(saveError instanceof Error ? saveError.message : 'API Key 保存失败。');
            }
          }}
          type="button"
        >
          保存 API Key
        </button>
        {stored ? (
          <button
            data-testid={`provider-secret-clear-${providerId}`}
            disabled={busy}
            onClick={async () => {
              try {
                await onClear();
                setError(null);
              } catch (clearError) {
                setError(clearError instanceof Error ? clearError.message : 'API Key 清除失败。');
              }
            }}
            type="button"
          >
            清除
          </button>
        ) : null}
      </div>
      {error === null ? null : (
        <span className="provider-secret-error" data-testid={`provider-secret-error-${providerId}`}>
          {error}
        </span>
      )}
    </div>
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
  onStartNewProvider: (type: EditableProviderType) => void;
  onTestProvider: (providerId: string) => Promise<void>;
  onUpdateDraft: (partial: Partial<ProviderDraft>) => void;
  providers: ProviderConfig[];
  providerSecretStatus: ProviderSecretStatus[];
  providerTestStatus: ProviderTestResult | null;
  secretBusyProviderId: string | null;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const providerTypeOptions: Array<{ type: EditableProviderType; label: string }> = [
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

  const meta = providerTypeMeta(draft.type);
  const isCreating = draft.mode === 'create';
  const stored = selectedProvider === null
    ? false
    : findSecret(providerSecretStatus, selectedProvider.id)?.stored === true;
  const busy = secretBusyProviderId !== null && secretBusyProviderId === selectedProvider?.id;

  const runtimeStatus = (() => {
    if (selectedProvider === null) {
      return null;
    }
    if (providerTestStatus !== null && providerTestStatus.providerId === selectedProvider.id) {
      return providerTestStatus.status;
    }
    return providerHasReadyModel(selectedProvider) ? 'ready' : 'invalid';
  })();

  return (
    <section className="card provider-settings-card" data-testid="provider-settings">
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
                  <span
                    className={ready ? 'provider-status-dot ready' : 'provider-status-dot idle'}
                    aria-label={ready ? '已就绪' : '未启用'}
                  />
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
          <p className="provider-detail-subtitle">{providerTypeLabel(draft.type)} · {meta.subtitle}</p>
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
          <div className="provider-detail-section">
            <span className="provider-detail-label">API Key</span>
            {selectedProvider === null ? (
              <p className="card-hint">保存 Provider 后可录入 API Key。</p>
            ) : (
              <ProviderSecretEditor
                busy={busy}
                onClear={() => onClearProviderSecret(selectedProvider.id)}
                onSave={(plaintext) => onSetProviderSecret(selectedProvider.id, plaintext)}
                providerId={selectedProvider.id}
                stored={stored}
              />
            )}
          </div>
          <label className="field">
            <span>Base URL</span>
            <input
              data-testid="provider-draft-endpoint"
              onChange={(event) => onUpdateDraft({ endpoint: event.currentTarget.value })}
              placeholder={meta.defaultBaseUrl}
              value={draft.endpoint}
            />
            <span className="field-hint">留空将回退到默认 {meta.defaultBaseUrl}</span>
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
          <div className="provider-detail-actions">
            <button data-testid="provider-save" onClick={() => void onSaveProviderDraft()} type="button">
              保存 Provider
            </button>
            {selectedProvider === null ? null : (
              <button
                className="provider-detail-delete"
                data-testid={`provider-delete-${selectedProvider.id}`}
                onClick={() => void onDeleteProvider(selectedProvider.id)}
                type="button"
              >
                删除
              </button>
            )}
            <span
              className={draftError === null ? 'pill ok' : 'pill warn'}
              data-testid="provider-draft-status"
            >
              {draftError === null ? draft.mode : draftError}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
