import { useEffect, useState } from 'react';
import type React from 'react';

import { providerModelOptionsSchema } from '../../../shared/schemas/ipc-memory-settings';
import type { ProviderModelOptions } from '../../../shared/types';
import type { EditableProviderType } from '../../settings-model';

type Props = {
  index: number;
  options: ProviderModelOptions | undefined;
  providerType: EditableProviderType;
  onChange: (options: ProviderModelOptions | undefined) => void;
};

function withoutEmptyOptions(options: ProviderModelOptions): ProviderModelOptions | undefined {
  return Object.keys(options).length === 0 ? undefined : providerModelOptionsSchema.parse(options);
}

function BooleanOption({ label, value, onChange }: {
  label: string;
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
}): React.JSX.Element {
  return <label className="field"><span>{label}</span><select value={value === undefined ? 'unset' : String(value)} onChange={(event) => onChange(event.currentTarget.value === 'unset' ? undefined : event.currentTarget.value === 'true')}><option value="unset">默认</option><option value="true">true</option><option value="false">false</option></select></label>;
}

function JsonOption({ label, value, onChange }: {
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (value: Record<string, unknown> | undefined) => void;
}): React.JSX.Element {
  const [text, setText] = useState(() => value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value === undefined ? '' : JSON.stringify(value, null, 2)), [value]);
  return <label className="field field--full"><span>{label}</span><textarea rows={3} value={text} onChange={(event) => setText(event.currentTarget.value)} onBlur={() => {
    if (text.trim().length === 0) { onChange(undefined); setError(null); return; }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象。');
      onChange(parsed as Record<string, unknown>); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '必须是合法 JSON 对象。'); }
  }} />{error === null ? null : <span className="pill warn">{error}</span>}</label>;
}

export function ProviderModelOptionsFields({ index, options, providerType, onChange }: Props): React.JSX.Element {
  const current = options ?? {};
  const set = <K extends keyof ProviderModelOptions>(key: K, value: ProviderModelOptions[K] | undefined): void => {
    const next = { ...current };
    if (value === undefined) delete next[key]; else next[key] = value;
    onChange(withoutEmptyOptions(next));
  };
  const numeric = (key: keyof ProviderModelOptions, value: string, integer = false): void => {
    if (value.trim().length === 0) { set(key, undefined); return; }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) return;
    set(key, parsed as never);
  };
  const list = (value: string): string[] | undefined => {
    const result = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    return result.length === 0 ? undefined : result;
  };
  return <div className="provider-model-options-fields" data-testid={`provider-model-options-fields-${index}`}>
    <div className="form-grid">
      <label className="field"><span>Temperature</span><input inputMode="decimal" value={current.temperature ?? ''} onChange={(event) => numeric('temperature', event.currentTarget.value)} /></label>
      <label className="field"><span>Max tokens</span><input inputMode="numeric" value={current.maxTokens ?? ''} onChange={(event) => numeric('maxTokens', event.currentTarget.value, true)} /></label>
      <label className="field"><span>Context budget</span><input inputMode="numeric" value={current.contextBudgetTokens ?? ''} onChange={(event) => numeric('contextBudgetTokens', event.currentTarget.value, true)} /></label>
      <label className="field"><span>top_p</span><input inputMode="decimal" value={current.topP ?? ''} onChange={(event) => numeric('topP', event.currentTarget.value)} /></label>
      <label className="field field--full"><span>stop</span><input value={current.stop?.join(', ') ?? ''} onChange={(event) => set('stop', list(event.currentTarget.value))} /></label>
    </div>
    {providerType === 'openai_compatible' ? <div className="form-grid">
      <label className="field"><span>frequency_penalty</span><input value={current.frequencyPenalty ?? ''} onChange={(event) => numeric('frequencyPenalty', event.currentTarget.value)} /></label>
      <label className="field"><span>presence_penalty</span><input value={current.presencePenalty ?? ''} onChange={(event) => numeric('presencePenalty', event.currentTarget.value)} /></label>
      <label className="field"><span>seed</span><input value={current.seed ?? ''} onChange={(event) => numeric('seed', event.currentTarget.value, true)} /></label>
      <BooleanOption label="useResponsesApi" value={current.useResponsesApi} onChange={(value) => set('useResponsesApi', value)} />
      <BooleanOption label="parallel_tool_calls" value={current.parallelToolCalls} onChange={(value) => set('parallelToolCalls', value)} />
      <BooleanOption label="stream_usage" value={current.streamUsage} onChange={(value) => set('streamUsage', value)} />
      <BooleanOption label="zdrEnabled" value={current.zdrEnabled} onChange={(value) => set('zdrEnabled', value)} />
      <label className="field"><span>reasoning.effort</span><select value={current.reasoning?.effort ?? 'unset'} onChange={(event) => set('reasoning', event.currentTarget.value === 'unset' && current.reasoning?.summary === undefined ? undefined : { ...current.reasoning, effort: event.currentTarget.value === 'unset' ? undefined : event.currentTarget.value as NonNullable<ProviderModelOptions['reasoning']>['effort'] })}><option value="unset">默认</option>{['none','minimal','low','medium','high','xhigh'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="field"><span>reasoning.summary</span><select value={current.reasoning?.summary ?? 'unset'} onChange={(event) => set('reasoning', event.currentTarget.value === 'unset' && current.reasoning?.effort === undefined ? undefined : { ...current.reasoning, summary: event.currentTarget.value === 'unset' ? undefined : event.currentTarget.value as NonNullable<ProviderModelOptions['reasoning']>['summary'] })}><option value="unset">默认</option>{['auto','concise','detailed'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="field"><span>service_tier</span><select value={current.serviceTier ?? 'unset'} onChange={(event) => set('serviceTier', event.currentTarget.value === 'unset' ? undefined : event.currentTarget.value as ProviderModelOptions['serviceTier'])}><option value="unset">默认</option>{['auto','default','flex','scale','priority'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="field"><span>verbosity</span><select value={current.verbosity ?? 'unset'} onChange={(event) => set('verbosity', event.currentTarget.value === 'unset' ? undefined : event.currentTarget.value as ProviderModelOptions['verbosity'])}><option value="unset">默认</option>{['low','medium','high'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <JsonOption label="model_kwargs" value={current.modelKwargs} onChange={(value) => set('modelKwargs', value as ProviderModelOptions['modelKwargs'])} />
    </div> : null}
    {providerType === 'anthropic_compatible' ? <div className="form-grid">
      <label className="field"><span>top_k</span><input value={current.topK ?? ''} onChange={(event) => numeric('topK', event.currentTarget.value, true)} /></label>
      <BooleanOption label="stream_usage" value={current.streamUsage} onChange={(value) => set('streamUsage', value)} />
      <label className="field"><span>thinking</span><select value={current.anthropicThinking?.mode ?? 'unset'} onChange={(event) => { const mode = event.currentTarget.value; set('anthropicThinking', mode === 'unset' ? undefined : mode === 'enabled' ? { mode, budgetTokens: 1024 } : { mode } as ProviderModelOptions['anthropicThinking']); }}><option value="unset">默认</option><option value="disabled">disabled</option><option value="adaptive">adaptive</option><option value="enabled">enabled</option></select></label>
      {current.anthropicThinking?.mode === 'enabled' ? <label className="field"><span>thinking.budget_tokens</span><input value={current.anthropicThinking.budgetTokens} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value)) set('anthropicThinking', { mode: 'enabled', budgetTokens: value }); }} /></label> : null}
      <label className="field field--full"><span>anthropic_betas</span><input value={current.anthropicBetas?.join(', ') ?? ''} onChange={(event) => set('anthropicBetas', list(event.currentTarget.value))} /></label>
      <JsonOption label="invocation_kwargs" value={current.invocationKwargs} onChange={(value) => set('invocationKwargs', value as ProviderModelOptions['invocationKwargs'])} />
    </div> : null}
    {providerType === 'nvidia' ? <div className="form-grid">
      <BooleanOption label="thinking" value={current.thinking} onChange={(value) => set('thinking', value)} />
      <label className="field"><span>top_k</span><input value={current.topK ?? ''} onChange={(event) => numeric('topK', event.currentTarget.value, true)} /></label>
      <label className="field"><span>min_p</span><input value={current.minP ?? ''} onChange={(event) => numeric('minP', event.currentTarget.value)} /></label>
      <label className="field"><span>frequency_penalty</span><input value={current.frequencyPenalty ?? ''} onChange={(event) => numeric('frequencyPenalty', event.currentTarget.value)} /></label>
      <label className="field"><span>presence_penalty</span><input value={current.presencePenalty ?? ''} onChange={(event) => numeric('presencePenalty', event.currentTarget.value)} /></label>
      <label className="field"><span>repetition_penalty</span><input value={current.repetitionPenalty ?? ''} onChange={(event) => numeric('repetitionPenalty', event.currentTarget.value)} /></label>
      <BooleanOption label="include_reasoning" value={current.includeReasoning} onChange={(value) => set('includeReasoning', value)} />
      <BooleanOption label="parallel_tool_calls" value={current.parallelToolCalls} onChange={(value) => set('parallelToolCalls', value)} />
      <BooleanOption label="stream_usage" value={current.streamUsage} onChange={(value) => set('streamUsage', value)} />
      <label className="field"><span>tool_choice</span><select value={typeof current.toolChoice === 'object' ? 'function' : current.toolChoice ?? 'unset'} onChange={(event) => set('toolChoice', event.currentTarget.value === 'unset' ? undefined : event.currentTarget.value === 'function' ? { type: 'function', function: { name: '' } } : event.currentTarget.value as ProviderModelOptions['toolChoice'])}><option value="unset">默认</option><option value="auto">auto</option><option value="required">required</option><option value="none">none</option><option value="function">function</option></select></label>
      {typeof current.toolChoice === 'object' ? <label className="field"><span>function.name</span><input value={current.toolChoice.function.name} onChange={(event) => set('toolChoice', { type: 'function', function: { name: event.currentTarget.value } })} /></label> : null}
      <JsonOption label="guided_json" value={current.guidedJson} onChange={(value) => set('guidedJson', value as ProviderModelOptions['guidedJson'])} />
      <label className="field"><span>guided_regex</span><input value={current.guidedRegex ?? ''} onChange={(event) => set('guidedRegex', event.currentTarget.value.trim() || undefined)} /></label>
      <label className="field"><span>guided_choice</span><input value={current.guidedChoice?.join(', ') ?? ''} onChange={(event) => set('guidedChoice', list(event.currentTarget.value))} /></label>
      <label className="field field--full"><span>guided_grammar</span><textarea rows={3} value={current.guidedGrammar ?? ''} onChange={(event) => set('guidedGrammar', event.currentTarget.value.trim() || undefined)} /></label>
    </div> : null}
    {providerType === 'llama_cpp' ? <div className="form-grid">
      <label className="field"><span>top_k</span><input value={current.topK ?? ''} onChange={(event) => numeric('topK', event.currentTarget.value, true)} /></label>
      <label className="field"><span>min_p</span><input value={current.minP ?? ''} onChange={(event) => numeric('minP', event.currentTarget.value)} /></label>
      <label className="field"><span>presence_penalty</span><input value={current.presencePenalty ?? ''} onChange={(event) => numeric('presencePenalty', event.currentTarget.value)} /></label>
      <label className="field"><span>repetition_penalty</span><input value={current.repetitionPenalty ?? ''} onChange={(event) => numeric('repetitionPenalty', event.currentTarget.value)} /></label>
      <JsonOption label="sampling_profile_overrides" value={current.samplingProfileOverrides} onChange={(value) => set('samplingProfileOverrides', value as ProviderModelOptions['samplingProfileOverrides'])} />
    </div> : null}
  </div>;
}
