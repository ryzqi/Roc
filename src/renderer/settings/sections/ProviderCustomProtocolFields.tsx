import type React from 'react';

import type { ProviderDraft } from '../../settings-model';

interface ProviderCustomProtocolFieldsProps {
  anthropicCompatibleDraft: boolean;
  draft: ProviderDraft;
  onUpdateDraft: (partial: Partial<ProviderDraft>) => void;
  openAiCompatibleDraft: boolean;
}

export function ProviderCustomProtocolFields({
  anthropicCompatibleDraft,
  draft,
  onUpdateDraft,
  openAiCompatibleDraft
}: ProviderCustomProtocolFieldsProps): React.JSX.Element {
  return (
    <>
      <div className="form-grid">
        <label className="field">
          <span>Temperature</span>
          <input
            data-testid="provider-draft-temperature"
            inputMode="decimal"
            onChange={(event) => onUpdateDraft({ temperature: event.currentTarget.value })}
            placeholder="0.7"
            value={draft.temperature}
          />
        </label>
        <label className="field">
          <span>Max tokens</span>
          <input
            data-testid="provider-draft-max-tokens"
            inputMode="numeric"
            onChange={(event) => onUpdateDraft({ maxTokens: event.currentTarget.value })}
            placeholder="4096"
            value={draft.maxTokens}
          />
        </label>
      </div>
      <details className="provider-advanced">
        <summary>{openAiCompatibleDraft ? 'OpenAI-compatible 高级参数' : 'Anthropic-compatible 高级参数'}</summary>
        <div className="form-grid">
          <label className="field">
            <span>top_p</span>
            <input
              data-testid="provider-draft-top-p"
              inputMode="decimal"
              onChange={(event) => onUpdateDraft({ topP: event.currentTarget.value })}
              placeholder="0.9"
              value={draft.topP}
            />
          </label>
          {openAiCompatibleDraft ? (
            <>
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
            </>
          ) : (
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
          )}
          <label className="field">
            <span>{anthropicCompatibleDraft ? 'stop_sequences（逗号或换行分隔）' : 'stop（逗号或换行分隔）'}</span>
            <input
              data-testid="provider-draft-stop"
              onChange={(event) => onUpdateDraft({ stop: event.currentTarget.value })}
              placeholder="<|end|>"
              value={draft.stop}
            />
          </label>
          {openAiCompatibleDraft ? (
            <label className="field">
              <span>organization</span>
              <input
                data-testid="provider-draft-organization"
                onChange={(event) => onUpdateDraft({ organization: event.currentTarget.value })}
                placeholder="org_123"
                value={draft.organization}
              />
            </label>
          ) : null}
          {openAiCompatibleDraft ? (
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
          ) : null}
          <label className="field">
            <span>{openAiCompatibleDraft ? 'stream_options.include_usage' : 'streamUsage'}</span>
            <select
              data-testid="provider-draft-stream-usage"
              onChange={(event) => onUpdateDraft({ streamUsage: event.currentTarget.value as ProviderDraft['streamUsage'] })}
              value={draft.streamUsage}
            >
              <option value="unset">默认</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>
          {openAiCompatibleDraft ? (
            <label className="field">
              <span>useResponsesApi</span>
              <select
                data-testid="provider-draft-use-responses-api"
                onChange={(event) => onUpdateDraft({ useResponsesApi: event.currentTarget.value as ProviderDraft['useResponsesApi'] })}
                value={draft.useResponsesApi}
              >
                <option value="unset">默认</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
          ) : null}
          {openAiCompatibleDraft ? (
            <label className="field">
              <span>reasoning.effort</span>
              <select
                data-testid="provider-draft-openai-reasoning-effort"
                onChange={(event) =>
                  onUpdateDraft({
                    openAiReasoningEffort: event.currentTarget.value as ProviderDraft['openAiReasoningEffort']
                  })
                }
                value={draft.openAiReasoningEffort}
              >
                <option value="unset">默认（按模型决定）</option>
                <option value="none">none</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            </label>
          ) : null}
          {openAiCompatibleDraft ? (
            <label className="field">
              <span>reasoning.summary</span>
              <select
                data-testid="provider-draft-openai-reasoning-summary"
                onChange={(event) =>
                  onUpdateDraft({
                    openAiReasoningSummary: event.currentTarget.value as ProviderDraft['openAiReasoningSummary']
                  })
                }
                value={draft.openAiReasoningSummary}
              >
                <option value="unset">默认</option>
                <option value="auto">auto</option>
                <option value="concise">concise</option>
                <option value="detailed">detailed</option>
              </select>
            </label>
          ) : null}
          {openAiCompatibleDraft ? (
            <label className="field">
              <span>parallel_tool_calls</span>
              <select
                data-testid="provider-draft-parallel-tool-calls"
                onChange={(event) =>
                  onUpdateDraft({ parallelToolCalls: event.currentTarget.value as ProviderDraft['parallelToolCalls'] })
                }
                value={draft.parallelToolCalls}
              >
                <option value="unset">默认</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
          ) : null}
          {openAiCompatibleDraft ? (
            <label className="field">
              <span>service_tier</span>
              <select
                data-testid="provider-draft-service-tier"
                onChange={(event) => onUpdateDraft({ serviceTier: event.currentTarget.value as ProviderDraft['serviceTier'] })}
                value={draft.serviceTier}
              >
                <option value="unset">默认</option>
                <option value="auto">auto</option>
                <option value="default">default</option>
                <option value="flex">flex</option>
                <option value="scale">scale</option>
                <option value="priority">priority</option>
              </select>
            </label>
          ) : null}
          {anthropicCompatibleDraft ? (
            <>
              <label className="field">
                <span>thinking</span>
                <select
                  data-testid="provider-draft-anthropic-thinking-mode"
                  onChange={(event) =>
                    onUpdateDraft({
                      anthropicThinkingMode: event.currentTarget.value as ProviderDraft['anthropicThinkingMode']
                    })
                  }
                  value={draft.anthropicThinkingMode}
                >
                  <option value="unset">默认（关闭）</option>
                  <option value="disabled">disabled</option>
                  <option value="adaptive">adaptive</option>
                  <option value="enabled">enabled</option>
                </select>
              </label>
              <label className="field">
                <span>thinking.budget_tokens</span>
                <input
                  data-testid="provider-draft-anthropic-thinking-budget-tokens"
                  disabled={draft.anthropicThinkingMode !== 'enabled'}
                  inputMode="numeric"
                  onChange={(event) => onUpdateDraft({ anthropicThinkingBudgetTokens: event.currentTarget.value })}
                  placeholder="2048"
                  value={draft.anthropicThinkingBudgetTokens}
                />
              </label>
            </>
          ) : null}
          <label className="field">
            <span>timeout_ms</span>
            <input
              data-testid="provider-draft-timeout-ms"
              inputMode="numeric"
              onChange={(event) => onUpdateDraft({ timeoutMs: event.currentTarget.value })}
              placeholder="120000"
              value={draft.timeoutMs}
            />
          </label>
          {openAiCompatibleDraft ? (
            <label className="field">
              <span>verbosity</span>
              <select
                data-testid="provider-draft-verbosity"
                onChange={(event) => onUpdateDraft({ verbosity: event.currentTarget.value as ProviderDraft['verbosity'] })}
                value={draft.verbosity}
              >
                <option value="unset">默认</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
          ) : null}
          {openAiCompatibleDraft ? (
            <label className="field">
              <span>zdrEnabled</span>
              <select
                data-testid="provider-draft-zdr-enabled"
                onChange={(event) => onUpdateDraft({ zdrEnabled: event.currentTarget.value as ProviderDraft['zdrEnabled'] })}
                value={draft.zdrEnabled}
              >
                <option value="unset">默认</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
          ) : null}
          <label className="field field--full">
            <span>default_headers（JSON 对象）</span>
            <textarea
              data-testid="provider-draft-default-headers"
              onChange={(event) => onUpdateDraft({ defaultHeaders: event.currentTarget.value })}
              placeholder='{ "x-client": "roc" }'
              rows={3}
              value={draft.defaultHeaders}
            />
          </label>
          {openAiCompatibleDraft ? (
            <label className="field field--full">
              <span>model_kwargs（JSON 对象）</span>
              <textarea
                data-testid="provider-draft-model-kwargs"
                onChange={(event) => onUpdateDraft({ modelKwargs: event.currentTarget.value })}
                placeholder='{ "chat_template_kwargs": { "enable_thinking": true } }'
                rows={4}
                value={draft.modelKwargs}
              />
            </label>
          ) : null}
        </div>
      </details>
    </>
  );
}
