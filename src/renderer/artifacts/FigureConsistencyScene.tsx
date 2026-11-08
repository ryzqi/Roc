import {useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchFigureConsistencyBinding, ResearchFigureConsistencyInspection} from '../../shared/schemas/research-figure-consistency';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {FigureConsistencyBindingFields} from './FigureConsistencyBindingFields';

const pageSize = 20;
export function FigureConsistencyScene({client, snapshot, report, editing, writable, locked, candidateDirty, onChange, onDiscard, onAdd}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; report: ResearchFigureConsistencyInspection['report'];
  editing: boolean; writable: boolean; locked: boolean; candidateDirty: boolean; onChange: () => void; onDiscard: () => void;
  onAdd: (binding: ResearchFigureConsistencyBinding) => void
}): React.JSX.Element {
  const [markName, setMarkName] = useState(''), [offset, setOffset] = useState(0);
  const mark = report.marks.find(value => value.name === markName);
  const page = useAsyncResource(mark === undefined ? null :
    `figure:scene:${report.projectId}:${report.artifactId}:${report.artifactVersion}:${report.trace.file.sha256}:${markName}:${offset}`, () =>
    client.api.research.inspectFigureConsistency({projectId: report.projectId, artifactId: report.artifactId,
      expectedHash: null, page: {markName, offset, limit: pageSize}}), {label: '读取图稿场景数据'});
  const current = page.status === 'ready' ? page.data : null;
  const matches = current !== null && current.report.artifactVersion === report.artifactVersion &&
    current.report.figure.id === report.figure.id && current.report.figure.manifestHash === report.figure.manifestHash &&
    current.report.trace.file.sha256 === report.trace.file.sha256;
  const navigationLocked = locked || candidateDirty || page.status === 'loading';
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-figure-consistency-scene">
    <label className="flex min-w-0 flex-col gap-1 text-muted">场景标记
      <select aria-label="场景标记" className={`${formInputClass} border-[0.5px]`} value={markName} disabled={navigationLocked}
        onChange={event => {setMarkName(event.target.value); setOffset(0);}}>
        <option value="">请选择</option>
        {report.marks.map(value => <option key={value.name} value={value.name}>{value.name}，{value.markType}，{value.itemCount} 项</option>)}
      </select>
    </label>
    {mark === undefined ? null : <>
      <p className="break-words text-muted">常量通道：{mark.constantChannels.join('，') || '无'}。无法直接映射的通道：{mark.unsupportedChannels.join('，') || '无'}。</p>
      <details className="text-muted"><summary className="cursor-pointer">完整场景编码</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{mark.encoding}</pre>
      </details>
    </>}
    {page.status === 'loading' ? <p role="status">正在读取场景数据…</p> : null}
    {page.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{page.error}
      <button type="button" className={formSecondaryButtonClass} disabled={locked || candidateDirty} onClick={page.reload}>重读场景数据</button>
    </p>}
    {current === null || matches ? null : <p role="alert" className="text-[var(--st-warn)]">图稿或工件已变化，请放弃修改并刷新工件。</p>}
    {!matches || current === null || mark === undefined ? null : <>
      <p className="text-muted tabular-nums" data-testid="artifact-figure-consistency-page">
        场景数据 {current.report.items.length === 0 ? 0 : offset + 1}–{offset + current.report.items.length}，共 {current.report.total} 项
      </p>
      <ul className="flex min-w-0 flex-col gap-2" data-testid="artifact-figure-consistency-items">
        {current.report.items.map(item => <li className="min-w-0 break-words" key={JSON.stringify(item.scenePath)}>
          <p>路径 {item.scenePath.join('/')}</p>
          <pre className="whitespace-pre-wrap break-all font-mono text-[length:var(--font-meta-size)]">{JSON.stringify(item.numericFields)}</pre>
          {item.unavailableFields.length === 0 ? null : <p className="text-muted">非数值字段：{item.unavailableFields.join('，')}</p>}
        </li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={formSecondaryButtonClass} disabled={navigationLocked || offset === 0}
          data-testid="artifact-figure-consistency-page-prev" onClick={() => setOffset(offset - pageSize)}>上一页场景</button>
        <button type="button" className={formSecondaryButtonClass} disabled={navigationLocked || offset + pageSize >= current.report.total}
          data-testid="artifact-figure-consistency-page-next" onClick={() => setOffset(offset + pageSize)}>下一页场景</button>
      </div>
      {!editing ? null : <FigureConsistencyBindingFields key={`${markName}:${offset}`} client={client} snapshot={snapshot}
        report={current.report} markName={markName} disabled={!writable || locked} onChange={onChange} onDiscard={onDiscard} onAdd={onAdd}/>}
    </>}
  </section>;
}
