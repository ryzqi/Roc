import type React from 'react';

import type { ProviderDraft } from '../../settings-model';

interface ProviderNvidiaFieldsProps {
  draft: ProviderDraft;
  onUpdateDraft: (partial: Partial<ProviderDraft>) => void;
}

export function ProviderNvidiaFields({ draft, onUpdateDraft }: ProviderNvidiaFieldsProps): React.JSX.Element {
  return (
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
  );
}
