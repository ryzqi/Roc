import {useRef, useState} from 'react';
import type {z} from 'zod';
import type {rerankerConfigSchema} from '../../../shared/schemas/research-reranker';
import type {RocClient} from '../../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../../app/use-async-resource';
import {useTransientSettingsEditor} from '../settings-editor-guard';
import {CheckboxField, TextField, NumberField, FormNote, formButtonClass} from '../../shared/form-ui';

type Config = z.infer<typeof rerankerConfigSchema>;
const defaults: Config = {endpoint: 'https://api.cohere.com/v2/rerank', model: 'rerank-v3.5',
  timeoutMs: 3000, enabled: false, keyConfigured: false};

export function RerankerSettings({client}: {client: RocClient}): React.JSX.Element {
  const resource = useAsyncResource('settings:reranker', () => client.api.research.readRerankerConfig(), {label: '读取精排配置'});
  if (resource.error) return <FormNote tone="warn">{resource.error}</FormNote>;
  if (resource.status !== 'ready') return <FormNote>精排配置读取中…</FormNote>;
  return <RerankerEditor client={client} initial={resource.data ?? defaults} />;
}

function RerankerEditor({client, initial}: {client: RocClient; initial: Config}): React.JSX.Element {
  const [form, setForm] = useState(initial);
  const [base, setBase] = useState(initial);
  const [apiKey, setApiKey] = useState('');
  const pendingRef = useRef(false);
  const save = useAsyncAction(() => {
    const {keyConfigured: _configured, ...settings} = form;
    return client.api.research.saveRerankerConfig({...settings, apiKey});
  }, {label: '保存精排配置'});
  useTransientSettingsEditor({label: '精排配置', dirty: apiKey.length > 0 || JSON.stringify(form) !== JSON.stringify(base),
    busy: save.pending, pendingRef, discard: () => {setForm(base); setApiKey('');}});
  return <fieldset disabled={save.pending} className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2">
    <legend className="text-ink">语义精排（可选）</legend>
    <FormNote>使用支持 Cohere Rerank 协议的模型。超时或不可用时使用融合排序。</FormNote>
    <div className="form-grid">
      <TextField testId="settings-reranker-endpoint" label="精排接口完整地址" value={form.endpoint} onChange={endpoint => setForm({...form, endpoint})} />
      <TextField testId="settings-reranker-model" label="精排模型" value={form.model} onChange={model => setForm({...form, model})} />
      <NumberField testId="settings-reranker-timeout" label="超时（毫秒）" value={form.timeoutMs} min={100} max={10000}
        onChange={timeoutMs => setForm({...form, timeoutMs: Number(timeoutMs)})} />
      <TextField testId="settings-reranker-key" label="精排 API Key（每次保存需要填写）" type="password" value={apiKey} onChange={setApiKey} />
    </div>
    <CheckboxField testId="settings-reranker-enabled" label="启用语义精排" checked={form.enabled} onChange={enabled => setForm({...form, enabled})} />
    <div><button type="button" className={formButtonClass} disabled={!apiKey.trim() || save.pending}
      onClick={() => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        void save.run().then(result => {
          if (result.ok) {setBase(result.data); setForm(result.data); setApiKey('');}
        }).finally(() => {pendingRef.current = false;});
      }}>保存精排配置</button></div>
    {save.error && <FormNote tone="warn">{save.error}</FormNote>}
  </fieldset>;
}
