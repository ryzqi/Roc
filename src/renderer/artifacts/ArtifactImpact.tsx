import {useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchStage} from '../../shared/types';
import {researchRepairStages} from '../../shared/schemas/research-repair';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {STAGE_LABELS} from '../project/project-store';
import {useArtifactEditorGuard, useArtifactEditorStatus} from './artifact-editor-guard';

type Props = {client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; writable: boolean; onRepaired: () => void};
type RepairRequest = Parameters<RocClient['api']['research']['startResearchRepair']>[0];
type ImpactResult = Extract<Awaited<ReturnType<RocClient['api']['research']['inspectResearchImpact']>>, {ok: true}>['data'];
const button = formSecondaryButtonClass;

export function ArtifactImpact({client, snapshot, writable, onRepaired}: Props): React.JSX.Element {
  const {projectId, id: artifactId} = snapshot.artifact;
  const source = {kind: 'artifact' as const, artifactId, expectedVersion: snapshot.version};
  const read = useAsyncResource(`research-impact:${projectId}:${artifactId}:${snapshot.version}`,
    () => client.api.research.inspectResearchImpact({projectId, source}), {label: '检查变更影响'});
  const guard = useArtifactEditorGuard();
  return <section className="mt-3 flex min-w-0 flex-col gap-3" aria-label="变更影响" data-testid="artifact-impact">
    <p className="text-muted">影响范围来自已记录的输入与引用关系。</p>
    <button type="button" className={`${button} self-start`} disabled={guard.locked() || read.status === 'loading'}
      data-testid="artifact-impact-refresh" onClick={read.reload}>重新检查影响</button>
    {read.status === 'loading' ? <p role="status">正在读取依赖关系…</p> : null}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
    {read.status !== 'ready' || read.data === null ? null : <ImpactReport key={read.data.reportHash}
      client={client} snapshot={snapshot} report={read.data} writable={writable} onRepaired={onRepaired}/>}
  </section>;
}

function ImpactReport({client, snapshot, report, writable, onRepaired}: Props & {report: ImpactResult}): React.JSX.Element {
  const projectId = snapshot.artifact.projectId;
  const [editing, setEditing] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const [inputs, setInputs] = useState<Partial<Record<ResearchStage, string[]>>>({});
  const [reason, setReason] = useState('');
  const busy = useRef(false);
  const prepared = useRef<{signature: string; request: RepairRequest} | null>(null);
  const {locked, isLocked} = useArtifactEditorStatus({label: '定向修复',
    dirty: targets.length > 0 || Object.values(inputs).some(ids => ids.length > 0) || reason !== '', pending: () => busy.current});
  const guard = useArtifactEditorGuard();
  const artifacts = useAsyncResource(editing ? `research-impact:basis:${projectId}:${report.reportHash}` : null,
    () => client.api.research.listArtifacts({projectId}), {label: '读取可用输入'});
  const candidates = artifacts.status === 'ready' ? artifacts.data?.filter(artifact => artifact.status === 'approved' &&
    !targets.includes(artifact.id)) ?? [] : [];
  const statusOf = (artifactId: string) => artifacts.data?.find(artifact => artifact.id === artifactId)?.status;
  const requiredIds = report.affected.filter(artifact => statusOf(artifact.artifactId) !== 'superseded' &&
    artifact.reasons.some(reason => reason.kind !== 'run_context')).map(artifact => artifact.artifactId);
  const stages = researchRepairStages(report.affected.filter(artifact => targets.includes(artifact.artifactId)));
  const ready = artifacts.status === 'ready' && targets.length > 0 && reason.trim() !== '' && requiredIds.every(id => targets.includes(id));
  const start = useAsyncAction(async () => {
    const selection = {projectId, source: report.source, expectedStage: snapshot.currentStage, expectedReportHash: report.reportHash,
      targetArtifactIds: targets, reason: reason.trim(), inputs: stages.map(stage => ({stage, artifacts: inputs[stage] ?? []}))};
    const signature = JSON.stringify(selection);
    if (prepared.current?.signature !== signature) {
      const selectedIds = [...new Set(selection.inputs.flatMap(input => input.artifacts))];
      const versions = new Map<string, string>();
      for (const id of selectedIds) {
        const current = await client.api.research.inspectArtifact({projectId, artifactId: id, expectedVersion: null});
        if (!current.ok) return current;
        if (current.data.status !== 'current' || current.data.snapshot.artifact.status !== 'approved') {
          throw new Error('输入工件已变化，请刷新影响报告。');
        }
        versions.set(id, current.data.snapshot.version);
      }
      prepared.current = {signature, request: {...selection, requestId: crypto.randomUUID(),
        inputs: selection.inputs.map(input => ({stage: input.stage,
          artifacts: input.artifacts.map(artifactId => ({artifactId, expectedVersion: versions.get(artifactId)!}))}))}};
    }
    return client.api.research.startResearchRepair(prepared.current.request);
  }, {label: '开始定向修复'});
  return <>
    {report.stale ? <p role="alert" className="text-[var(--st-warn)]">来源版本已变化，请先刷新工件。</p> : null}
    <details className="min-w-0 text-muted">
      <summary className="cursor-pointer">本次检查版本</summary>
      <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt>来源工件</dt><dd className="break-all">{snapshot.artifact.id}</dd>
        <dt>来源版本</dt><dd className="break-all font-mono">{snapshot.version}</dd>
        <dt>报告</dt><dd className="break-all font-mono">{report.reportHash}</dd>
      </dl>
    </details>
    <section className="flex min-w-0 flex-col gap-2" aria-label="受影响工件">
      <h3 className="font-medium tabular-nums">受影响工件（{report.affected.length.toLocaleString()}）</h3>
      <ul className="flex min-w-0 flex-col gap-3">{report.affected.map(artifact => <li key={artifact.artifactId}
        className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line pt-2">
        {editing ? <label className="flex min-w-0 items-start gap-2">
          <input type="checkbox" className="mt-1 shrink-0" disabled={locked || start.pending || artifacts.status !== 'ready' ||
            statusOf(artifact.artifactId) === 'superseded'} checked={targets.includes(artifact.artifactId)}
            onChange={event => {
              const checked = event.target.checked;
              const next = checked ? [...targets, artifact.artifactId] : targets.filter(id => id !== artifact.artifactId);
              const nextStages = researchRepairStages(report.affected.filter(artifact => next.includes(artifact.artifactId)));
              setTargets(next);
              setInputs(previous => Object.fromEntries(nextStages.map(stage => [stage,
                previous[stage]?.filter(id => !next.includes(id)) ?? []])));
              start.reset();
            }}/>
          <span className="break-words">{artifact.title}（{STAGE_LABELS[artifact.stage]}）</span>
        </label> : <p className="break-words">{artifact.title}（{STAGE_LABELS[artifact.stage]}）</p>}
        {!editing ? null : <span className="text-muted">{statusOf(artifact.artifactId) === 'superseded' ? '历史工件' :
          requiredIds.includes(artifact.artifactId) ? '直接依赖，需一并修复' : '仅记录为运行上下文，可选'}</span>}
        <p className="break-all text-muted">{artifact.artifactId}</p>
        <ul className="flex min-w-0 flex-col gap-1 text-muted">{artifact.reasons.map((reason, index) => <li key={index}>
          <p className="break-words">{reason.detail}</p><span className="break-all">{reason.subjectId}</span>
        </li>)}</ul>
      </li>)}</ul>
    </section>
    <details className="min-w-0 text-muted">
      <summary className="cursor-pointer tabular-nums">保留工件（{report.preservedArtifactIds.length.toLocaleString()}）</summary>
      <ul className="mt-2 flex min-w-0 flex-col gap-1">{report.preservedArtifactIds.map(id => <li className="break-all" key={id}>{id}</li>)}</ul>
    </details>
    {!writable || report.stale || report.affected.length === 0 ? null : <>
      <button type="button" className={`${button} self-start`} disabled={locked || start.pending} aria-expanded={editing}
        data-testid="artifact-impact-repair-open" onClick={() => guard.request(() => {
          setEditing(!editing); setTargets([]); setInputs({}); setReason(''); start.reset();
        }, '收起将放弃修复范围和输入选择。')}>{editing ? '取消修复选择' : '选择定向修复'}</button>
      {!editing ? null : <>
        {artifacts.status === 'loading' ? <p role="status">正在读取已批准输入…</p> : null}
        {artifacts.error === null ? null : <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-[var(--st-warn)]">{artifacts.error}</p>
          <button type="button" className={button} disabled={start.pending} onClick={artifacts.reload}>重新读取输入</button>
        </div>}
        {stages.map(stage => <fieldset key={stage} disabled={locked || start.pending} className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 font-medium">{STAGE_LABELS[stage]}阶段输入</legend>
          {candidates.map(artifact => <label key={artifact.id} className="flex min-w-0 items-start gap-2">
            <input type="checkbox" className="mt-1 shrink-0" checked={inputs[stage]?.includes(artifact.id) ?? false}
              onChange={event => {const checked = event.target.checked; setInputs(previous => ({...previous,
                [stage]: checked ? [...previous[stage] ?? [], artifact.id] : previous[stage]?.filter(id => id !== artifact.id) ?? []})); start.reset();}}/>
            <span className="min-w-0 break-words">{artifact.title}<span className="block break-all text-muted">{artifact.id}</span></span>
          </label>)}
          {candidates.length > 0 || artifacts.status !== 'ready' ? null : <p className="text-muted">没有可选的已批准输入。</p>}
          <p className="text-muted">此前修复阶段的新产物会自动加入；其余输入需明确选择。</p>
        </fieldset>)}
        <label className="flex min-w-0 flex-col gap-1 text-muted">修复理由
          <textarea className={`${formInputClass} h-auto resize-y py-2`} rows={3} maxLength={4000} value={reason}
            disabled={locked || start.pending} onChange={event => {setReason(event.target.value); start.reset();}}/>
        </label>
        <p className="text-muted">所选工件会进入重新生成与审核，保留原回执。输入版本将在提交时核对。</p>
        <button type="button" className={`${formPrimaryButtonClass} self-start`} disabled={!ready || locked || start.pending}
          data-testid="artifact-impact-repair-start" onClick={() => {
            if (busy.current || isLocked() || !ready) return;
            busy.current = true;
            void start.run().then(result => {busy.current = false;
              if (result.ok) {setTargets([]); setInputs({}); setReason(''); onRepaired();}});
          }}>{start.pending ? '正在准备修复…' : '确认并开始定向修复'}</button>
        {start.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{start.error}</p>}
      </>}
    </>}
  </>;
}
