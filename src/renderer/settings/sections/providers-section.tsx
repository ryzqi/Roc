import { useState } from 'react';
import type React from 'react';
import type {
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult
} from '../../../shared/types';
import {
  type EditableProviderType,
  type ProviderDraft
} from '../../settings-model';
import { FieldRow, InfoRow, StatusPill } from '../atoms';

function providerTypeLabel(type: ProviderConfig['type']): string {
  if (type === 'openai_compatible') {
    return '兼容服务';
  }
  if (type === 'anthropic_compatible') {
    return 'Anthropic 兼容';
  }
  if (type === 'ollama') {
    return 'Ollama';
  }
  return '自定义兼容端点';
}

function providerRuntimeStatus(
  provider: ProviderConfig,
  providerTestStatus: ProviderTestResult | null
): string {
  if (providerTestStatus !== null && providerTestStatus.providerId === provider.id) {
    return providerTestStatus.status;
  }
  return provider.enabled && provider.models.some((model) => model.enabled) ? 'ready' : 'invalid';
}

function findSecret(
  statuses: readonly ProviderSecretStatus[],
  providerId: string
): ProviderSecretStatus | null {
  return statuses.find((entry) => entry.providerId === providerId) ?? null;
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
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="provider-secret-editor">
      <input
        autoComplete="off"
        data-testid={`provider-secret-input-${providerId}`}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          setError(null);
        }}
        placeholder={stored ? '输入新 API Key 以替换已存储凭据' : '输入 API Key 后点击保存'}
        type="password"
        value={value}
      />
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
  return (
    <>
      <section className="card" data-testid="provider-settings">
        <div className="card-title">
          模型 Provider <StatusPill label="数量" tone="info" value={String(providers.length)} />
        </div>
        <div className="card-pad settings-form">
          <div className="settings-actions">
            <button
              data-testid="provider-add-openai"
              onClick={() => onStartNewProvider('openai_compatible')}
              type="button"
            >
              新增 OpenAI-compatible
            </button>
            <button
              data-testid="provider-add-anthropic"
              onClick={() => onStartNewProvider('anthropic_compatible')}
              type="button"
            >
              新增 Anthropic-compatible
            </button>
          </div>
          <div className="form-grid">
            <FieldRow label="Provider ID">
              <input
                data-testid="provider-draft-id"
                onChange={(event) => onUpdateDraft({ id: event.currentTarget.value })}
                value={draft.id}
              />
            </FieldRow>
            <FieldRow label="名称">
              <input
                data-testid="provider-draft-name"
                onChange={(event) => onUpdateDraft({ name: event.currentTarget.value })}
                value={draft.name}
              />
            </FieldRow>
            <FieldRow label="类型">
              <select
                data-testid="provider-draft-type"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value === 'openai_compatible' || value === 'anthropic_compatible') {
                    onUpdateDraft({ type: value });
                  }
                }}
                value={draft.type}
              >
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="anthropic_compatible">Anthropic-compatible</option>
              </select>
            </FieldRow>
            <FieldRow label="Endpoint">
              <input
                data-testid="provider-draft-endpoint"
                onChange={(event) => onUpdateDraft({ endpoint: event.currentTarget.value })}
                value={draft.endpoint}
              />
            </FieldRow>
            <label className="field checkbox-field">
              <span>启用</span>
              <input
                checked={draft.enabled}
                data-testid="provider-draft-enabled"
                onChange={(event) => onUpdateDraft({ enabled: event.currentTarget.checked })}
                type="checkbox"
              />
            </label>
          </div>
          <FieldRow hint="一行一个模型，格式：modelId | displayName" label="模型列表">
            <textarea
              data-testid="provider-draft-models"
              onChange={(event) => onUpdateDraft({ modelsText: event.currentTarget.value })}
              rows={4}
              value={draft.modelsText}
            />
          </FieldRow>
          <div className="settings-actions">
            <button data-testid="provider-save" onClick={() => void onSaveProviderDraft()} type="button">
              保存 Provider
            </button>
            <span
              className={draftError === null ? 'pill ok' : 'pill warn'}
              data-testid="provider-draft-status"
            >
              {draftError === null ? draft.mode : draftError}
            </span>
          </div>
          <p className="card-hint">
            Provider 凭据现在使用本机加密存储（Electron safeStorage）。新 Provider 保存后，请在下方列表中为对应条目录入 API Key。
          </p>
        </div>
      </section>
      <section className="card">
        <div className="card-title">已配置 Provider</div>
        {providers.length === 0 ? (
          <InfoRow sub="尚未配置 provider" tag="blocked" title="模型提供商" tone="warn" />
        ) : (
          providers.map((provider) => {
            const secret = findSecret(providerSecretStatus, provider.id);
            const stored = secret?.stored === true;
            const busy = secretBusyProviderId === provider.id;
            return (
              <div className="provider-row" key={provider.id}>
                <div className="provider-row-head">
                  <div className="provider-row-meta">
                    <div className="row-title">{provider.name}</div>
                    <div className="row-sub">
                      {provider.id} · {providerTypeLabel(provider.type)} · {provider.endpoint} ·{' '}
                      {provider.models.map((model) => model.id).join(', ')} · {provider.id}:
                      {providerRuntimeStatus(provider, providerTestStatus)}
                    </div>
                  </div>
                  <span
                    className={stored ? 'pill ok' : 'pill warn'}
                    data-testid={`provider-secret-status-${provider.id}`}
                  >
                    {stored ? '凭据已存储' : '凭据未存储'}
                  </span>
                  <span className={provider.enabled ? 'pill ok' : 'pill warn'}>
                    {provider.enabled ? `${provider.models.length} models` : 'disabled'}
                  </span>
                  <div className="provider-row-buttons">
                    <button
                      data-testid={`provider-test-${provider.id}`}
                      onClick={() => void onTestProvider(provider.id)}
                      type="button"
                    >
                      测试
                    </button>
                    <button
                      data-testid={`provider-edit-${provider.id}`}
                      onClick={() => onEditProvider(provider)}
                      type="button"
                    >
                      编辑
                    </button>
                    <button
                      data-testid={`provider-delete-${provider.id}`}
                      onClick={() => void onDeleteProvider(provider.id)}
                      type="button"
                    >
                      删除
                    </button>
                  </div>
                </div>
                <ProviderSecretEditor
                  busy={busy}
                  onClear={() => onClearProviderSecret(provider.id)}
                  onSave={(plaintext) => onSetProviderSecret(provider.id, plaintext)}
                  providerId={provider.id}
                  stored={stored}
                />
              </div>
            );
          })
        )}
      </section>
    </>
  );
}
