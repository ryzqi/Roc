import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type {
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult
} from '../../../shared/types';
import { isFixedProvider, isFixedProviderType } from '../../../shared/provider-defaults';
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
  const fixedProviderDraft = isFixedProviderType(draft.type);
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
              <p className="provider-nvidia-note" data-testid="provider-nvidia-endpoint-note">
                NVIDIA 公共聚合 endpoint <code>integrate.api.nvidia.com</code> 为多租户共享，
                高峰时段 TTFT 经常出现 15–70 秒抖动（实测 P95 ≈ 70 s），属于上游服务正常表现。
                如需稳定低延时，请在下方「高级参数 → endpoint_override」配置自建 NIM 部署。
              </p>
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
              <label className="field">
                <span>thinking / reasoning</span>
                <select
                  data-testid="provider-draft-thinking"
                  onChange={(event) => onUpdateDraft({ thinking: event.currentTarget.value as ProviderDraft['thinking'] })}
                  value={draft.thinking}
                >
                  <option value="unset">默认（按模型决定）</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </label>
              <details className="provider-nvidia-advanced">
                <summary>NVIDIA NIM 高级参数</summary>
                <div className="form-grid">
                  <label className="field">
                    <span>top_p</span>
                    <input
                      data-testid="provider-draft-top-p"
                      inputMode="decimal"
                      onChange={(event) => onUpdateDraft({ topP: event.currentTarget.value })}
                      placeholder="0.95"
                      value={draft.topP}
                    />
                  </label>
                  <label className="field">
                    <span>top_k</span>
                    <input
                      data-testid="provider-draft-top-k"
                      inputMode="numeric"
                      onChange={(event) => onUpdateDraft({ topK: event.currentTarget.value })}
                      placeholder="20"
                      value={draft.topK}
                    />
                  </label>
                  <label className="field">
                    <span>min_p</span>
                    <input
                      data-testid="provider-draft-min-p"
                      inputMode="decimal"
                      onChange={(event) => onUpdateDraft({ minP: event.currentTarget.value })}
                      placeholder="0"
                      value={draft.minP}
                    />
                  </label>
                  <label className="field">
                    <span>frequency_penalty</span>
                    <input
                      data-testid="provider-draft-frequency-penalty"
                      inputMode="decimal"
                      onChange={(event) => onUpdateDraft({ frequencyPenalty: event.currentTarget.value })}
                      placeholder="0"
                      value={draft.frequencyPenalty}
                    />
                  </label>
                  <label className="field">
                    <span>presence_penalty</span>
                    <input
                      data-testid="provider-draft-presence-penalty"
                      inputMode="decimal"
                      onChange={(event) => onUpdateDraft({ presencePenalty: event.currentTarget.value })}
                      placeholder="0"
                      value={draft.presencePenalty}
                    />
                  </label>
                  <label className="field">
                    <span>repetition_penalty</span>
                    <input
                      data-testid="provider-draft-repetition-penalty"
                      inputMode="decimal"
                      onChange={(event) => onUpdateDraft({ repetitionPenalty: event.currentTarget.value })}
                      placeholder="1.0"
                      value={draft.repetitionPenalty}
                    />
                  </label>
                  <label className="field">
                    <span>seed</span>
                    <input
                      data-testid="provider-draft-seed"
                      inputMode="numeric"
                      onChange={(event) => onUpdateDraft({ seed: event.currentTarget.value })}
                      placeholder="42"
                      value={draft.seed}
                    />
                  </label>
                  <label className="field">
                    <span>stop（逗号或换行分隔，最多 4 个）</span>
                    <input
                      data-testid="provider-draft-stop"
                      onChange={(event) => onUpdateDraft({ stop: event.currentTarget.value })}
                      placeholder="<|end|>"
                      value={draft.stop}
                    />
                  </label>
                  <label className="field">
                    <span>include_reasoning</span>
                    <select
                      data-testid="provider-draft-include-reasoning"
                      onChange={(event) =>
                        onUpdateDraft({ includeReasoning: event.currentTarget.value as ProviderDraft['includeReasoning'] })
                      }
                      value={draft.includeReasoning}
                    >
                      <option value="unset">默认（保留推理 tokens）</option>
                      <option value="true">显式 true</option>
                      <option value="false">false（仅非流式生效）</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>parallel_tool_calls</span>
                    <select
                      data-testid="provider-draft-parallel-tool-calls"
                      onChange={(event) =>
                        onUpdateDraft({ parallelToolCalls: event.currentTarget.value as ProviderDraft['parallelToolCalls'] })
                      }
                      value={draft.parallelToolCalls}
                    >
                      <option value="unset">默认（按模型决定）</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>stream_options.include_usage</span>
                    <select
                      data-testid="provider-draft-stream-usage"
                      onChange={(event) => onUpdateDraft({ streamUsage: event.currentTarget.value as ProviderDraft['streamUsage'] })}
                      value={draft.streamUsage}
                    >
                      <option value="unset">默认（true）</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>tool_choice</span>
                    <select
                      data-testid="provider-draft-tool-choice"
                      onChange={(event) => onUpdateDraft({ toolChoice: event.currentTarget.value as ProviderDraft['toolChoice'] })}
                      value={draft.toolChoice}
                    >
                      <option value="unset">默认</option>
                      <option value="auto">auto</option>
                      <option value="required">required</option>
                      <option value="none">none</option>
                      <option value="function">指定 function</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>tool_choice function.name</span>
                    <input
                      data-testid="provider-draft-tool-choice-function-name"
                      disabled={draft.toolChoice !== 'function'}
                      onChange={(event) => onUpdateDraft({ toolChoiceFunctionName: event.currentTarget.value })}
                      placeholder="lookup"
                      value={draft.toolChoiceFunctionName}
                    />
                  </label>
                  <label className="field field--full">
                    <span>endpoint_override（自托管 NIM URL，留空使用官方端点）</span>
                    <input
                      data-testid="provider-draft-endpoint-override"
                      onChange={(event) => onUpdateDraft({ endpointOverride: event.currentTarget.value })}
                      placeholder="http://localhost:8000/v1"
                      value={draft.endpointOverride}
                    />
                  </label>
                  <label className="field field--full">
                    <span>nvext.guided_json（JSON Schema，留空禁用）</span>
                    <textarea
                      data-testid="provider-draft-guided-json"
                      onChange={(event) => onUpdateDraft({ guidedJson: event.currentTarget.value })}
                      placeholder='{ "type": "object", "properties": {} }'
                      rows={3}
                      value={draft.guidedJson}
                    />
                  </label>
                  <label className="field field--full">
                    <span>nvext.guided_regex</span>
                    <input
                      data-testid="provider-draft-guided-regex"
                      onChange={(event) => onUpdateDraft({ guidedRegex: event.currentTarget.value })}
                      placeholder="^[A-Z]{3}-\\d{4}$"
                      value={draft.guidedRegex}
                    />
                  </label>
                  <label className="field field--full">
                    <span>nvext.guided_choice（逗号或换行分隔）</span>
                    <input
                      data-testid="provider-draft-guided-choice"
                      onChange={(event) => onUpdateDraft({ guidedChoice: event.currentTarget.value })}
                      placeholder="yes, no, maybe"
                      value={draft.guidedChoice}
                    />
                  </label>
                  <label className="field field--full">
                    <span>nvext.guided_grammar（EBNF）</span>
                    <textarea
                      data-testid="provider-draft-guided-grammar"
                      onChange={(event) => onUpdateDraft({ guidedGrammar: event.currentTarget.value })}
                      placeholder='?start: "ok"'
                      rows={3}
                      value={draft.guidedGrammar}
                    />
                  </label>
                </div>
              </details>
            </>
          ) : null}
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
