import type {ResearchExportInputs, ResearchExportResourceReview} from '../../shared/schemas/research-export-publication';
import {formSelectClass} from '../shared/form-ui';
import {ExportMetadataFields, ExportTextField, type ExportMetadataDraft} from './ExportMetadataFields';

export type ExportResourceDraft = ExportMetadataDraft & {
  kind: '' | ResearchExportResourceReview['kind'];
  delivery: '' | 'bundled' | 'metadata_only'; acquisitionUrl: string; instructions: string
};
const kinds = {software: '软件', dataset: '数据', result: '结果', figure: '图稿'} as const;
export function ExportResourceEditor({candidate, value, onChange}: {
  candidate: ResearchExportInputs['resources'][number]; value: ExportResourceDraft; onChange: (value: ExportResourceDraft) => void
}): React.JSX.Element {
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-export-resource-editor">
    <p className="break-all text-muted">{candidate.source.kind} / {candidate.source.area} / {candidate.source.path}</p>
    <p className="break-all font-mono text-muted text-[length:var(--font-meta-size)]">
      SHA-256 {candidate.source.sha256}，{candidate.source.size} B
    </p>
    {candidate.reason === null ? null : <p className="break-words text-muted">{candidate.reason}</p>}
    <label className="flex flex-col gap-1 text-muted">科研对象类型
      <select className={`${formSelectClass} border-[0.5px]`} value={value.kind}
        onChange={event => onChange({...value, kind: event.target.value as ExportResourceDraft['kind']})}>
        <option value="">选择对象类型</option>
        {Object.entries(kinds).filter(([kind]) => candidate.role === 'program' ? kind === 'software' :
          candidate.role === 'figure' ? kind === 'figure' : true).map(([kind, label]) =>
          <option value={kind} key={kind}>{label}</option>)}
      </select>
    </label>
    <ExportMetadataFields value={value} onChange={metadata => onChange({...value, ...metadata})}/>
    <label className="flex flex-col gap-1 text-muted">交付方式
      <select className={`${formSelectClass} border-[0.5px]`} value={value.delivery}
        onChange={event => onChange({...value, delivery: event.target.value as ExportResourceDraft['delivery']})}>
        <option value="">选择交付方式</option>
        <option value="bundled">已确认再分发权限，随包交付原件</option>
        <option value="metadata_only" disabled={candidate.mandatory}>仅元数据，原件另行获取</option>
      </select>
    </label>
    {value.delivery !== 'metadata_only' ? null : <>
      <ExportTextField label="获取 URL（可留空）" value={value.acquisitionUrl}
        onChange={acquisitionUrl => onChange({...value, acquisitionUrl})}/>
      <ExportTextField label="获取说明" multiline value={value.instructions}
        onChange={instructions => onChange({...value, instructions})}/>
    </>}
  </section>;
}
