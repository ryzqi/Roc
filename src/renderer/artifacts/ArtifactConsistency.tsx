import {useEffect, useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ConsistencyReceipt, consistencySurfaces} from './ConsistencyReceipt';
import {ConsistencyEditor} from './ConsistencyEditor';

const button = `${formSecondaryButtonClass} border-[0.5px]`, pageSize = 10;
export function ArtifactConsistency({client, snapshot, writable, locked: externalLocked, onDirty, onPending, onSaved}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; writable: boolean; locked: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const baseline = useRef<string | null>(null);
  const [editing, setEditing] = useState(false), [dirty, setDirty] = useState(false), [pending, setPending] = useState(false);
  const [offset, setOffset] = useState<number | null>(null);
  const {projectId, id: artifactId} = snapshot.artifact;
  const locked = externalLocked || dirty || pending;
  const read = useAsyncResource(`consistency:inspect:${artifactId}:${snapshot.version}`,
    () => client.api.research.inspectConsistency({projectId, artifactId, expectedHash: baseline.current}), {label: '检查科研数值'});
  const result = read.status === 'ready' ? read.data : null;
  const history = useAsyncResource(offset === null ? null : `consistency:history:${artifactId}:${snapshot.version}:${offset}`,
    () => client.api.research.getConsistencyHistory({projectId, artifactId, offset: offset!, limit: pageSize}), {label: '读取数值审核历史'});
  useEffect(() => {if (result?.status === 'current') baseline.current = result.reportHash;}, [result]);
  const matchesArtifact = result !== null && result.report.artifactVersion === snapshot.version;
  return <section className="mt-2 flex min-w-0 flex-col gap-3" data-testid="artifact-consistency" aria-label="科研数值一致性">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="font-medium">科研数值一致性</h2>
      <button type="button" className={button} disabled={locked || read.status === 'loading'} data-testid="artifact-consistency-refresh"
        onClick={() => {setEditing(false); read.reload();}}>重新检查数值</button>
    </div>
    {read.status === 'loading' ? <p role="status">正在核对数值与来源指标…</p> : null}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
    {result !== null && !matchesArtifact ? <p role="alert" className="text-[var(--st-warn)]" data-testid="artifact-consistency-artifact-changed">
        工件已变化，请先刷新工件。
      </p> : null}
    {result === null || !matchesArtifact ? null : <>
      {result.status !== 'stale' ? null : <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-[var(--st-warn)]">数值审核报告已变化，请核对当前版本。</p>
        <button type="button" className={button} disabled={locked || !matchesArtifact} data-testid="artifact-consistency-recapture"
          onClick={() => {setEditing(false); baseline.current = result.reportHash; read.reload();}}>按当前版本核对数值</button>
      </div>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted tabular-nums">
        {Object.entries({已映射: result.report.counts.mapped, 数值一致: result.report.counts.consistent,
          数值不一致: result.report.counts.inconsistent, 主张已变化: result.report.counts.changed,
          未映射数值: result.report.counts.unmappedValues}).map(([label, value]) => <div className="contents" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        <dt>报告 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]" data-testid="artifact-consistency-hash">{result.reportHash}</dd>
      </dl>
      <p className="text-muted">数值一致不代表科学批准。图稿说明的数值不代表实际绘制数据已核对。</p>
      <ul className="flex min-w-0 flex-col gap-2" data-testid="artifact-consistency-unmapped">
        {result.report.unmappedLocations.map(value => <li className="break-words" key={`${value.claimId}:${value.start}:${value.end}`}>
          未映射 {value.text}，字符 {value.start}–{value.end}：{snapshot.claims.find(item => item.id === value.claimId)!.content}
        </li>)}
      </ul>
      <ul className="flex min-w-0 flex-col gap-2" data-testid="artifact-consistency-locations">
        {result.report.locations.map(({binding, calculation, current}) => <li className="break-words" key={`${binding.claimId}:${binding.start}:${binding.end}`}>
          {consistencySurfaces[binding.surface]}，{current ? calculation.consistent ? '数值一致' : '数值不一致' : '主张已变化'}，
          展示 {calculation.observedText} {binding.unit}，期望 {calculation.expectedText} {binding.unit}，
          差异 {calculation.difference}，允许 {calculation.allowedDifference}
        </li>)}
      </ul>
      {result.report.review === null ? <p className="text-muted">尚无保存的数值审核。</p> : <ConsistencyReceipt receipt={result.report.review}/>}
      <button type="button" className={`${button} self-start`} disabled={locked || !matchesArtifact || result.status !== 'current'}
        data-testid="artifact-consistency-edit" onClick={() => setEditing(value => !value)}>{editing ? '收起映射编辑' : '编辑数值映射'}</button>
      {!editing ? null : <ConsistencyEditor key={result.reportHash} client={client} snapshot={snapshot} report={result.report}
        writable={writable && !externalLocked && matchesArtifact && result.status === 'current'}
        onDirty={value => {setDirty(value); onDirty(value);}} onPending={value => {setPending(value); onPending(value);}}
        onSaved={onSaved}/>}
    </>}
    <button type="button" className={`${button} self-start`} disabled={locked || history.status === 'loading'}
      data-testid="artifact-consistency-history-open" onClick={() => {if (offset === 0) history.reload(); else setOffset(0);}}>读取数值审核历史</button>
    {history.status === 'loading' ? <p role="status">正在读取保存的数值审核历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null || offset === null ? null : <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-consistency-history">
      <p className="text-muted">保存回执，共 {history.data.total} 版。历史来源未按当前版本复核。</p>
      {history.data.items.map(receipt => <ConsistencyReceipt key={receipt.snapshot.id} receipt={receipt}/>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={locked || offset === 0}
          data-testid="artifact-consistency-history-prev" onClick={() => setOffset(offset - pageSize)}>上一页审核</button>
        <button type="button" className={button} disabled={locked || offset + pageSize >= history.data.total}
          data-testid="artifact-consistency-history-next" onClick={() => setOffset(offset + pageSize)}>下一页审核</button>
      </div>
    </section>}
  </section>;
}
