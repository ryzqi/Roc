import { useEffect, useState } from 'react';
import type React from 'react';

import { providerModelOptionsSchema } from '../../../shared/schemas/ipc-memory-settings';
import type { ProviderModelOptions } from '../../../shared/types';
import { Select, TextArea, TextInput } from '../../components/ui';
import type { EditableProviderType } from '../../settings-model';

type Props = { index: number; options: ProviderModelOptions | undefined; providerType: EditableProviderType; onChange: (options: ProviderModelOptions | undefined) => void };

function withoutEmptyOptions(options: ProviderModelOptions): ProviderModelOptions | undefined {
  return Object.keys(options).length === 0 ? undefined : providerModelOptionsSchema.parse(options);
}

function TextOption({ full = false, label, onChange, value, inputMode }: { full?: boolean; label: string; onChange: (value: string) => void; value: string | number | undefined; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'] }): React.JSX.Element {
  return <label className={full ? 'field field--full' : 'field'}><span>{label}</span><TextInput inputMode={inputMode} onChange={(event) => onChange(event.currentTarget.value)} value={value ?? ''} /></label>;
}

function SelectOption({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: string[]; value: string | undefined }): React.JSX.Element {
  return <label className="field"><span>{label}</span><Select onChange={(event) => onChange(event.currentTarget.value)} value={value ?? 'unset'}><option value="unset">默认</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</Select></label>;
}

function JsonOption({ label, value, onChange }: { label: string; value: Record<string, unknown> | undefined; onChange: (value: Record<string, unknown> | undefined) => void }): React.JSX.Element {
  const [text, setText] = useState(() => value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value === undefined ? '' : JSON.stringify(value, null, 2)), [value]);
  function commit(): void {
    if (text.trim().length === 0) { onChange(undefined); setError(null); return; }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象。');
      onChange(parsed as Record<string, unknown>);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '必须是合法 JSON 对象。'); }
  }
  return <label className="field field--full"><span>{label}</span><TextArea onBlur={commit} onChange={(event) => setText(event.currentTarget.value)} rows={3} value={text} />{error === null ? null : <span className="pill warn">{error}</span>}</label>;
}

export function ProviderModelOptionsFields({ index, options, providerType, onChange }: Props): React.JSX.Element {
  const current = options ?? {};
  function set<K extends keyof ProviderModelOptions>(key: K, value: ProviderModelOptions[K] | undefined): void {
    const next = { ...current };
    if (value === undefined) delete next[key]; else next[key] = value;
    onChange(withoutEmptyOptions(next));
  }
  function numeric(key: keyof ProviderModelOptions, value: string, integer = false): void {
    if (value.trim().length === 0) { set(key, undefined); return; }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && (!integer || Number.isInteger(parsed))) set(key, parsed as never);
  }
  function list(value: string): string[] | undefined {
    const result = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    return result.length === 0 ? undefined : result;
  }
  const number = (label: string, key: keyof ProviderModelOptions, integer = false): React.JSX.Element => <TextOption inputMode="decimal" label={label} onChange={(value) => numeric(key, value, integer)} value={current[key] as number | undefined} />;
  const bool = (label: string, key: keyof ProviderModelOptions): React.JSX.Element => <SelectOption label={label} onChange={(value) => set(key, value === 'unset' ? undefined : value === 'true' as never)} options={['true', 'false']} value={current[key] === undefined ? undefined : String(current[key])} />;

  return <div className="provider-model-options-fields" data-testid={`provider-model-options-fields-${index}`}>
    <div className="form-grid">
      {number('Temperature', 'temperature')}{number('Max tokens', 'maxTokens', true)}{number('Context budget', 'contextBudgetTokens', true)}{number('top_p', 'topP')}
      <TextOption full label="stop" onChange={(value) => set('stop', list(value))} value={current.stop?.join(', ')} />
    </div>
    {providerType === 'openai_compatible' ? <div className="form-grid">
      {number('frequency_penalty', 'frequencyPenalty')}{number('presence_penalty', 'presencePenalty')}{number('seed', 'seed', true)}
      {bool('useResponsesApi', 'useResponsesApi')}{bool('parallel_tool_calls', 'parallelToolCalls')}{bool('stream_usage', 'streamUsage')}{bool('zdrEnabled', 'zdrEnabled')}
      <SelectOption label="reasoning.effort" onChange={(value) => set('reasoning', value === 'unset' && current.reasoning?.summary === undefined ? undefined : { ...current.reasoning, effort: value === 'unset' ? undefined : value as NonNullable<ProviderModelOptions['reasoning']>['effort'] })} options={['none', 'minimal', 'low', 'medium', 'high', 'xhigh']} value={current.reasoning?.effort} />
      <SelectOption label="reasoning.summary" onChange={(value) => set('reasoning', value === 'unset' && current.reasoning?.effort === undefined ? undefined : { ...current.reasoning, summary: value === 'unset' ? undefined : value as NonNullable<ProviderModelOptions['reasoning']>['summary'] })} options={['auto', 'concise', 'detailed']} value={current.reasoning?.summary} />
      <SelectOption label="service_tier" onChange={(value) => set('serviceTier', value === 'unset' ? undefined : value as ProviderModelOptions['serviceTier'])} options={['auto', 'default', 'flex', 'scale', 'priority']} value={current.serviceTier} />
      <SelectOption label="verbosity" onChange={(value) => set('verbosity', value === 'unset' ? undefined : value as ProviderModelOptions['verbosity'])} options={['low', 'medium', 'high']} value={current.verbosity} />
      <JsonOption label="model_kwargs" onChange={(value) => set('modelKwargs', value as ProviderModelOptions['modelKwargs'])} value={current.modelKwargs} />
    </div> : null}
    {providerType === 'anthropic_compatible' ? <div className="form-grid">
      {number('top_k', 'topK', true)}{bool('stream_usage', 'streamUsage')}
      <SelectOption label="thinking" onChange={(value) => set('anthropicThinking', value === 'unset' ? undefined : value === 'enabled' ? { mode: value, budgetTokens: 1024 } : { mode: value } as ProviderModelOptions['anthropicThinking'])} options={['disabled', 'adaptive', 'enabled']} value={current.anthropicThinking?.mode} />
      {current.anthropicThinking?.mode === 'enabled' ? <TextOption label="thinking.budget_tokens" onChange={(value) => { const parsed = Number(value); if (Number.isInteger(parsed)) set('anthropicThinking', { mode: 'enabled', budgetTokens: parsed }); }} value={current.anthropicThinking.budgetTokens} /> : null}
      <TextOption full label="anthropic_betas" onChange={(value) => set('anthropicBetas', list(value))} value={current.anthropicBetas?.join(', ')} />
      <JsonOption label="invocation_kwargs" onChange={(value) => set('invocationKwargs', value as ProviderModelOptions['invocationKwargs'])} value={current.invocationKwargs} />
    </div> : null}
    {providerType === 'nvidia' ? <div className="form-grid">
      {bool('thinking', 'thinking')}{number('top_k', 'topK', true)}{number('min_p', 'minP')}{number('frequency_penalty', 'frequencyPenalty')}{number('presence_penalty', 'presencePenalty')}{number('repetition_penalty', 'repetitionPenalty')}
      {bool('include_reasoning', 'includeReasoning')}{bool('parallel_tool_calls', 'parallelToolCalls')}{bool('stream_usage', 'streamUsage')}
      <SelectOption label="tool_choice" onChange={(value) => set('toolChoice', value === 'unset' ? undefined : value === 'function' ? { type: 'function', function: { name: '' } } : value as ProviderModelOptions['toolChoice'])} options={['auto', 'required', 'none', 'function']} value={typeof current.toolChoice === 'object' ? 'function' : current.toolChoice} />
      {typeof current.toolChoice === 'object' ? <TextOption label="function.name" onChange={(value) => set('toolChoice', { type: 'function', function: { name: value } })} value={current.toolChoice.function.name} /> : null}
      <JsonOption label="guided_json" onChange={(value) => set('guidedJson', value as ProviderModelOptions['guidedJson'])} value={current.guidedJson} />
      <TextOption label="guided_regex" onChange={(value) => set('guidedRegex', value.trim() || undefined)} value={current.guidedRegex} />
      <TextOption label="guided_choice" onChange={(value) => set('guidedChoice', list(value))} value={current.guidedChoice?.join(', ')} />
      <label className="field field--full"><span>guided_grammar</span><TextArea onChange={(event) => set('guidedGrammar', event.currentTarget.value.trim() || undefined)} rows={3} value={current.guidedGrammar ?? ''} /></label>
    </div> : null}
    {providerType === 'llama_cpp' ? <div className="form-grid">
      {number('top_k', 'topK', true)}{number('min_p', 'minP')}{number('presence_penalty', 'presencePenalty')}{number('repetition_penalty', 'repetitionPenalty')}
      <JsonOption label="sampling_profile_overrides" onChange={(value) => set('samplingProfileOverrides', value as ProviderModelOptions['samplingProfileOverrides'])} value={current.samplingProfileOverrides} />
    </div> : null}
  </div>;
}
