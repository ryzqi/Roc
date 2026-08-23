import { useEffect, useState } from 'react';
import type React from 'react';

import { providerModelOptionsSchema } from '../../../shared/schemas/ipc-memory-settings';
import type { ProviderModelOptions } from '../../../shared/types';
import { Select, TextArea, TextInput } from '../../components/ui';
import type { EditableProviderType } from '../../settings-model';
import { FieldLabel } from './provider-field-label';

type Props = { index: number; options: ProviderModelOptions | undefined; providerType: EditableProviderType; onChange: (options: ProviderModelOptions | undefined) => void };
type EnumOption = { label: string; value: string };

const boolOptions: EnumOption[] = [{ label: '开启', value: 'true' }, { label: '关闭', value: 'false' }];
const effortOptions: EnumOption[] = [
  { label: '关闭', value: 'none' }, { label: '极低', value: 'minimal' }, { label: '低', value: 'low' },
  { label: '中', value: 'medium' }, { label: '高', value: 'high' }, { label: '极高', value: 'xhigh' }
];
const summaryOptions: EnumOption[] = [
  { label: '自动', value: 'auto' }, { label: '简要', value: 'concise' }, { label: '详细', value: 'detailed' }
];
const serviceTierOptions: EnumOption[] = [
  { label: '自动', value: 'auto' }, { label: '默认', value: 'default' }, { label: '弹性', value: 'flex' },
  { label: '扩容', value: 'scale' }, { label: '优先', value: 'priority' }
];
const verbosityOptions: EnumOption[] = [
  { label: '简洁', value: 'low' }, { label: '适中', value: 'medium' }, { label: '详尽', value: 'high' }
];
const thinkingModeOptions: EnumOption[] = [
  { label: '关闭', value: 'disabled' }, { label: '自适应', value: 'adaptive' }, { label: '开启', value: 'enabled' }
];
const toolChoiceOptions: EnumOption[] = [
  { label: '自动', value: 'auto' }, { label: '必须调用', value: 'required' },
  { label: '禁止调用', value: 'none' }, { label: '指定函数', value: 'function' }
];

function withoutEmptyOptions(options: ProviderModelOptions): ProviderModelOptions | undefined {
  return Object.keys(options).length === 0 ? undefined : providerModelOptionsSchema.parse(options);
}

function TextOption({ apiName, full = false, hint, label, onChange, value, inputMode }: { apiName?: string; full?: boolean; hint?: string; label: string; onChange: (value: string) => void; value: string | number | undefined; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'] }): React.JSX.Element {
  return <label className={full ? 'field field--full' : 'field'}><FieldLabel apiName={apiName} text={label} /><TextInput inputMode={inputMode} onChange={(event) => onChange(event.currentTarget.value)} value={value ?? ''} />{hint === undefined ? null : <span className="field-hint">{hint}</span>}</label>;
}

function SelectOption({ apiName, hint, label, onChange, options, value }: { apiName?: string; hint?: string; label: string; onChange: (value: string) => void; options: EnumOption[]; value: string | undefined }): React.JSX.Element {
  return <label className="field"><FieldLabel apiName={apiName} text={label} /><Select onChange={(event) => onChange(event.currentTarget.value)} value={value ?? 'unset'}><option value="unset">默认（不设置）</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>{hint === undefined ? null : <span className="field-hint">{hint}</span>}</label>;
}

function JsonOption({ apiName, hint, label, value, onChange }: { apiName?: string; hint?: string; label: string; value: Record<string, unknown> | undefined; onChange: (value: Record<string, unknown> | undefined) => void }): React.JSX.Element {
  const [text, setText] = useState(() => value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value === undefined ? '' : JSON.stringify(value, null, 2)), [value]);
  function commit(): void {
    if (text.trim().length === 0) { onChange(undefined); setError(null); return; }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('内容必须是 JSON 对象。');
      onChange(parsed as Record<string, unknown>);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '内容必须是合法的 JSON 对象。'); }
  }
  return <label className="field field--full"><FieldLabel apiName={apiName} text={label} /><TextArea onBlur={commit} onChange={(event) => setText(event.currentTarget.value)} rows={3} value={text} />{hint === undefined ? null : <span className="field-hint">{hint}</span>}{error === null ? null : <span className="pill warn">{error}</span>}</label>;
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
  const number = (label: string, key: keyof ProviderModelOptions, integer = false, apiName?: string, hint?: string): React.JSX.Element => <TextOption apiName={apiName} hint={hint} inputMode="decimal" label={label} onChange={(value) => numeric(key, value, integer)} value={current[key] as number | undefined} />;
  const bool = (label: string, key: keyof ProviderModelOptions, apiName?: string, hint?: string): React.JSX.Element => <SelectOption apiName={apiName} hint={hint} label={label} onChange={(value) => set(key, value === 'unset' ? undefined : value === 'true' as never)} options={boolOptions} value={current[key] === undefined ? undefined : String(current[key])} />;

  return <div className="provider-model-options-fields" data-testid={`provider-model-options-fields-${index}`}>
    <div className="form-grid">
      {number('随机性', 'temperature', false, 'temperature', '越高输出越发散，0 最确定')}{number('单次最大输出', 'maxTokens', true, 'max_tokens', '单次回复的 token 上限')}{number('上下文预算', 'contextBudgetTokens', true, 'context_budget', '送入模型的历史 token 上限')}{number('核采样阈值', 'topP', false, 'top_p', '与随机性二选一，一般只调其中一个')}
      <TextOption apiName="stop" full hint="命中即截断，多个用逗号或换行分隔" label="停止序列" onChange={(value) => set('stop', list(value))} value={current.stop?.join(', ')} />
    </div>
    {providerType === 'openai_compatible' ? <div className="form-grid">
      {number('重复词惩罚', 'frequencyPenalty', false, 'frequency_penalty', '抑制同一词反复出现')}{number('新话题倾向', 'presencePenalty', false, 'presence_penalty', '提高值鼓励换新话题')}{number('随机种子', 'seed', true, 'seed', '同参数同种子尽量复现同一输出')}
      {bool('使用 Responses 接口', 'useResponsesApi', 'useResponsesApi')}{bool('允许并行调用工具', 'parallelToolCalls', 'parallel_tool_calls')}{bool('流式返回用量统计', 'streamUsage', 'stream_usage')}{bool('零数据保留', 'zdrEnabled', 'zdrEnabled', '开启后供应商不留存请求内容')}
      <SelectOption apiName="reasoning.effort" label="推理投入程度" onChange={(value) => set('reasoning', value === 'unset' && current.reasoning?.summary === undefined ? undefined : { ...current.reasoning, effort: value === 'unset' ? undefined : value as NonNullable<ProviderModelOptions['reasoning']>['effort'] })} options={effortOptions} value={current.reasoning?.effort} />
      <SelectOption apiName="reasoning.summary" label="推理摘要详细度" onChange={(value) => set('reasoning', value === 'unset' && current.reasoning?.effort === undefined ? undefined : { ...current.reasoning, summary: value === 'unset' ? undefined : value as NonNullable<ProviderModelOptions['reasoning']>['summary'] })} options={summaryOptions} value={current.reasoning?.summary} />
      <SelectOption apiName="service_tier" label="服务档位" onChange={(value) => set('serviceTier', value === 'unset' ? undefined : value as ProviderModelOptions['serviceTier'])} options={serviceTierOptions} value={current.serviceTier} />
      <SelectOption apiName="verbosity" label="回复详细度" onChange={(value) => set('verbosity', value === 'unset' ? undefined : value as ProviderModelOptions['verbosity'])} options={verbosityOptions} value={current.verbosity} />
      <JsonOption apiName="model_kwargs" hint="合法 JSON 对象，原样透传给模型" label="额外模型参数" onChange={(value) => set('modelKwargs', value as ProviderModelOptions['modelKwargs'])} value={current.modelKwargs} />
    </div> : null}
    {providerType === 'anthropic_compatible' ? <div className="form-grid">
      {number('候选词数量上限', 'topK', true, 'top_k')}{bool('流式返回用量统计', 'streamUsage', 'stream_usage')}
      <SelectOption apiName="thinking" label="扩展思考" onChange={(value) => set('anthropicThinking', value === 'unset' ? undefined : value === 'enabled' ? { mode: value, budgetTokens: 1024 } : { mode: value } as ProviderModelOptions['anthropicThinking'])} options={thinkingModeOptions} value={current.anthropicThinking?.mode} />
      {current.anthropicThinking?.mode === 'enabled' ? <TextOption apiName="thinking.budget_tokens" hint="思考过程可用的 token 上限" label="思考预算" onChange={(value) => { const parsed = Number(value); if (Number.isInteger(parsed)) set('anthropicThinking', { mode: 'enabled', budgetTokens: parsed }); }} value={current.anthropicThinking.budgetTokens} /> : null}
      <TextOption apiName="anthropic_betas" full hint="填 beta 标识，多个用逗号分隔" label="Beta 功能开关" onChange={(value) => set('anthropicBetas', list(value))} value={current.anthropicBetas?.join(', ')} />
      <JsonOption apiName="invocation_kwargs" hint="合法 JSON 对象，原样透传" label="额外调用参数" onChange={(value) => set('invocationKwargs', value as ProviderModelOptions['invocationKwargs'])} value={current.invocationKwargs} />
    </div> : null}
    {providerType === 'nvidia' ? <div className="form-grid">
      {bool('扩展思考', 'thinking', 'thinking')}{number('候选词数量上限', 'topK', true, 'top_k')}{number('最小概率阈值', 'minP', false, 'min_p', '低于该概率的候选词被丢弃')}{number('重复词惩罚', 'frequencyPenalty', false, 'frequency_penalty')}{number('新话题倾向', 'presencePenalty', false, 'presence_penalty')}{number('重复惩罚系数', 'repetitionPenalty', false, 'repetition_penalty', '1 表示不惩罚')}
      {bool('返回推理内容', 'includeReasoning', 'include_reasoning')}{bool('允许并行调用工具', 'parallelToolCalls', 'parallel_tool_calls')}{bool('流式返回用量统计', 'streamUsage', 'stream_usage')}
      <SelectOption apiName="tool_choice" label="工具选择策略" onChange={(value) => set('toolChoice', value === 'unset' ? undefined : value === 'function' ? { type: 'function', function: { name: '' } } : value as ProviderModelOptions['toolChoice'])} options={toolChoiceOptions} value={typeof current.toolChoice === 'object' ? 'function' : current.toolChoice} />
      {typeof current.toolChoice === 'object' ? <TextOption apiName="function.name" label="指定函数名" onChange={(value) => set('toolChoice', { type: 'function', function: { name: value } })} value={current.toolChoice.function.name} /> : null}
      <JsonOption apiName="guided_json" label="输出 JSON Schema 约束" onChange={(value) => set('guidedJson', value as ProviderModelOptions['guidedJson'])} value={current.guidedJson} />
      <TextOption apiName="guided_regex" label="输出正则约束" onChange={(value) => set('guidedRegex', value.trim() || undefined)} value={current.guidedRegex} />
      <TextOption apiName="guided_choice" hint="多个用逗号分隔" label="输出候选项约束" onChange={(value) => set('guidedChoice', list(value))} value={current.guidedChoice?.join(', ')} />
      <label className="field field--full"><FieldLabel apiName="guided_grammar" text="输出语法约束" /><TextArea onChange={(event) => set('guidedGrammar', event.currentTarget.value.trim() || undefined)} rows={3} value={current.guidedGrammar ?? ''} /><span className="field-hint">EBNF 语法</span></label>
    </div> : null}
    {providerType === 'llama_cpp' ? <div className="form-grid">
      {number('候选词数量上限', 'topK', true, 'top_k')}{number('最小概率阈值', 'minP', false, 'min_p', '低于该概率的候选词被丢弃')}{number('新话题倾向', 'presencePenalty', false, 'presence_penalty')}{number('重复惩罚系数', 'repetitionPenalty', false, 'repetition_penalty', '1 表示不惩罚')}
      <JsonOption apiName="sampling_profile_overrides" hint="合法 JSON 对象" label="采样档位覆盖" onChange={(value) => set('samplingProfileOverrides', value as ProviderModelOptions['samplingProfileOverrides'])} value={current.samplingProfileOverrides} />
    </div> : null}
  </div>;
}
