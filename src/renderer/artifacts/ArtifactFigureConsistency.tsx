import {useEffect, useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {FigureConsistencyReceipt} from './FigureConsistencyReceipt';
import {FigureConsistencyEditor} from './FigureConsistencyEditor';

const button = `${formSecondaryButtonClass} border-[0.5px]`, pageSize = 10;
export function ArtifactFigureConsistency({client, snapshot, writable, locked: externalLocked, onDirty, onPending, onSaved}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; writable: boolean; locked: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const baseline = useRef<string | null>(null);
  const [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false), [pending, setPending] = useState(false);
  const [offset, setOffset] = useState<number | null>(null);
  const {projectId, id: artifactId} = snapshot.artifact;
  const locked = externalLocked || dirty || pending;
  const read = useAsyncResource(`figure:inspect:${projectId}:${artifactId}:${snapshot.version}`,
    () => client.api.research.inspectFigureConsistency({projectId, artifactId, expectedHash: baseline.current,
      page: {markName: null, offset: 0, limit: 20}}), {label: '检查图稿绘制数据'});
  const result = read.status === 'ready' ? read.data : null;
  const history = useAsyncResource(offset === null ? null : `figure:history:${projectId}:${artifactId}:${snapshot.version}:${offset}`,
    () => client.api.research.getFigureConsistencyHistory({projectId, artifactId, offset: offset!, limit: pageSize}), {label: '读取图稿数据审核历史'});
  useEffect(() => {if (result?.status === 'current') baseline.current = result.reportHash;}, [result]);
  const matchesArtifact = result !== null && result.report.artifactVersion === snapshot.version;
  return <section className="mt-2 flex min-w-0 flex-col gap-3" data-testid="artifact-figure-consistency" aria-label="图稿绘制数据一致性">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-medium">图稿绘制数据一致性</h2>
      <button type="button" className={button} disabled={locked || read.status === 'loading'} data-testid="artifact-figure-consistency-refresh"
        onClick={() => {setEditing(false); read.reload();}}>重新检查绘制数据</button>
    </div>
    {read.status === 'loading' ? <p role="status">正在核对场景数据与来源指标…</p> : null}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
    {result === null || matchesArtifact ? null : <p role="alert" className="text-[var(--st-warn)]">工件已变化，请先刷新工件。</p>}
    {result === null || !matchesArtifact ? null : <>
      {result.status !== 'stale' ? null : <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-[var(--st-warn)]">图稿数据审核报告已变化，请核对当前版本。</p>
        <button type="button" className={button} disabled={locked} data-testid="artifact-figure-consistency-recapture"
          onClick={() => {setEditing(false); baseline.current = result.reportHash; read.reload();}}>按当前版本核对绘制数据</button>
      </div>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted tabular-nums">
        {Object.entries({场景数值位置: result.report.counts.numericLocations, 数值一致: result.report.counts.consistent,
          数值不一致: result.report.counts.inconsistent, 主张已变化: result.report.counts.changed, 未映射: result.report.counts.unmapped})
          .map(([label, value]) => <div className="contents" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        <dt>图稿清单 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]">{result.report.figure.manifestHash}</dd>
        <dt>场景 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]">{result.report.trace.file.sha256}</dd>
        <dt>报告 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]" data-testid="artifact-figure-consistency-hash">{result.reportHash}</dd>
      </dl>
      <p className="text-muted">场景数据一致不代表科学批准，也不验证最终像素位置。</p>
      <ul className="flex min-w-0 flex-col gap-2" data-testid="artifact-figure-consistency-locations">
        {result.report.locations.map(({binding, calculation, current}) => <li className="break-words"
          key={JSON.stringify([binding.markName, binding.channel, binding.scenePath])}>
          {binding.field}，{current ? calculation.consistent ? '数值一致' : '数值不一致' : '主张已变化'}，
          展示 {calculation.observedText} {binding.unit}，期望 {calculation.expectedText} {binding.unit}，
          差异 {calculation.difference}，允许 {calculation.allowedDifference}
        </li>)}
      </ul>
      {result.report.review === null ? <p className="text-muted">尚无保存的图稿数据审核。</p> : <FigureConsistencyReceipt receipt={result.report.review}/>}
      <button type="button" className={`${button} self-start`} disabled={locked || result.status !== 'current'}
        data-testid="artifact-figure-consistency-edit" onClick={() => setEditing(value => !value)}>{editing ? '收起图稿映射编辑' : '编辑图稿数据映射'}</button>
      <FigureConsistencyEditor key={result.reportHash} client={client} snapshot={snapshot} report={result.report} editing={editing}
        writable={writable && matchesArtifact && result.status === 'current'} externalLocked={externalLocked}
        onDirty={value => {setDirty(value); onDirty(value);}} onPending={value => {setPending(value); onPending(value);}} onSaved={onSaved}/>
    </>}
    <button type="button" className={`${button} self-start`} disabled={locked || history.status === 'loading'}
      data-testid="artifact-figure-consistency-history-open" onClick={() => {if (offset === 0) history.reload(); else setOffset(0);}}>读取图稿数据审核历史</button>
    {history.status === 'loading' ? <p role="status">正在读取保存的图稿审核历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null || offset === null ? null : <section className="flex min-w-0 flex-col gap-3"
      data-testid="artifact-figure-consistency-history">
      <p className="text-muted">保存回执，共 {history.data.total} 版。历史来源未按当前版本复核。</p>
      {history.data.items.map(receipt => <FigureConsistencyReceipt key={receipt.snapshot.id} receipt={receipt}/>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={locked || offset === 0}
          data-testid="artifact-figure-consistency-history-prev" onClick={() => setOffset(offset - pageSize)}>上一页图稿审核</button>
        <button type="button" className={button} disabled={locked || offset + pageSize >= history.data.total}
          data-testid="artifact-figure-consistency-history-next" onClick={() => setOffset(offset + pageSize)}>下一页图稿审核</button>
      </div>
    </section>}
  </section>;
}
