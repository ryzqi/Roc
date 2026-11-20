import {useState} from 'react';
import type {LiteratureAcquisitionSettings} from '../../shared/schemas/literature-acquisition';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';

const control = 'min-h-7 min-w-0 rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-50';

export function AcquisitionPreferences({client, writable}: {client: RocClient; writable: boolean}): React.JSX.Element {
  const resource = useAsyncResource('acquisition-preferences', () => client.api.research.acquisitionSettings({}), {label: '读取全文获取偏好'});
  return <div className="space-y-2 border-t-[0.5px] border-line px-3 py-2">
    {resource.error ? <p role="alert">{resource.error}<button className={control} onClick={resource.reload}>重试读取</button></p> : null}
    {resource.data === null ? resource.error ? null : <p role="status">正在读取偏好…</p> :
      <PreferencesForm client={client} initial={resource.data} writable={writable}/>}
  </div>;
}

function PreferencesForm({client, initial, writable}: {
  client: RocClient; initial: LiteratureAcquisitionSettings; writable: boolean
}): React.JSX.Element {
  const [preference, setPreference] = useState(initial.versionPreference);
  const [email, setEmail] = useState(initial.unpaywallEmail ?? '');
  const [saved, setSaved] = useState(false);
  const action = useAsyncAction((value: LiteratureAcquisitionSettings) => client.api.research.saveAcquisitionSettings(value), {label: '保存全文获取偏好'});
  return <form className="space-y-2" onSubmit={event => {
    event.preventDefault();
    if (!writable || action.pending) return;
    setSaved(false);
    void action.run({versionPreference: preference, unpaywallEmail: email.trim() || null}).then(result => setSaved(result.ok));
  }}>
    <p className="text-muted">全文获取偏好适用于所有项目，在下次来源解析时生效。已下载副本保留。</p>
    <label className="flex flex-wrap items-center gap-2">PDF 版本偏好
      <select className={control} value={preference} disabled={!writable || action.pending} onChange={event => {
        setPreference(event.target.value as LiteratureAcquisitionSettings['versionPreference']); setSaved(false);
      }}>
        <option value="balanced">按来源顺序</option><option value="published">优先正式发表版</option><option value="preprint">优先预印本</option>
      </select>
    </label>
    <label className="flex flex-wrap items-center gap-2">Unpaywall 联系邮箱（可选）
      <input className={`${control} flex-1`} type="email" maxLength={254} value={email} autoComplete="off" disabled={!writable || action.pending}
        onChange={event => {setEmail(event.target.value); setSaved(false);}}/>
    </label>
    <p className="text-muted">填写后，找不到或无法下载全文时会向 Unpaywall 发送 DOI 和此邮箱。清空即可停用。</p>
    <button className={control} disabled={!writable || action.pending}>保存获取偏好</button>
    {action.error ? <p role="alert">{action.error}</p> : null}
    {saved ? <p role="status">获取偏好已保存。</p> : null}
  </form>;
}
