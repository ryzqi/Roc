import {useRef, useState} from 'react';
import type {ResearchExternalExperimentDerivation, ResearchExternalExperimentResultGet} from '../../shared/schemas/research-external-experiments';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import type {RocClient} from '../shared/roc-client';
import {useArtifactEditorStatus} from './artifact-editor-guard';

export function ExternalExperimentResult({client, projectId, result, writable}: {client: RocClient; projectId: string;
  result: Omit<ResearchExternalExperimentResultGet, 'projectId'>; writable: boolean;
}): React.JSX.Element {
  const base = {projectId, ...result};
  const [metricId, setMetricId] = useState(''), [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, string>>({});
  const busy = useRef(false);
  const status = useArtifactEditorStatus({label: '外部报告证据', dirty: false, pending: () => busy.current});
  const read = useAsyncResource(`external-result:${projectId}:${result.resultId}:${result.expectedHash}`,
    () => client.api.research.getExternalExperimentResult(base), {label: '读取冻结外部报告'});
  const derive = useAsyncResource(`external-result:derive:${projectId}:${result.resultId}:${result.expectedHash}`,
    () => client.api.research.deriveExternalExperimentResult(base), {label: '生成外部报告材料'});
  const capture = useAsyncAction(() => client.api.research.captureExternalExperimentMetric({...base, metricId}), {label: '保存外部指标证据'});
  const figure = useAsyncAction((item: ResearchExternalExperimentDerivation['figures'][number]) =>
    client.api.research.prepareExternalExperimentFigure({...base, sourceHash: item.sourceHash}), {label: '准备外部指标绘图源'});
  const receipt = read.status === 'ready' ? read.data : null, material = derive.status === 'ready' ? derive.data : null;
  const pending = capture.pending || figure.pending;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-external-result">
    <h3 className="font-medium">外部报告，未经独立验证</h3>
    <p className="break-all text-muted">{result.resultId}，SHA-256 {result.expectedHash}</p>
    {receipt === null ? null : <p className="break-words text-muted">报告环境：{receipt.snapshot.report.environment.description}，报告人 {receipt.snapshot.report.environment.reportedBy}</p>}
    {material === null ? null : <>
      <p className="whitespace-pre-wrap break-words">{material.methods}</p>
      <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">{material.rows.map(row => <div className="contents" key={row.metric.id}>
        <dt className="break-words">{row.definition.label}</dt><dd className="tabular-nums">{row.metric.value} {row.metric.unit}，n={row.metric.sampleSize}</dd>
      </div>)}</dl>
      <fieldset disabled={!writable || status.locked || pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex flex-col gap-1 text-muted">外部证据指标
          <select className={formInputClass} value={metricId} onChange={event => {setMetricId(event.target.value); setEvidenceId(null); capture.reset();}}>
            <option value="">选择冻结报告中的指标</option>{material.rows.map(row => <option key={row.metric.id} value={row.metric.id}>{row.definition.label}</option>)}
          </select>
        </label>
        <button type="button" className={`${formSecondaryButtonClass} self-start`} disabled={metricId === ''} data-testid="artifact-external-capture" onClick={() => {
          if (busy.current || status.isLocked()) return;
          busy.current = true;
          void capture.run().then(result => {busy.current = false; if (result.ok) {setEvidenceId(result.data.id); derive.reload();}});
        }}>{capture.pending ? '正在保存…' : '保存为外部报告证据'}</button>
        {evidenceId === null ? null : <p role="status" className="break-all text-muted">外部报告证据 {evidenceId}</p>}
        {material.figures.map(item => <div className="flex min-w-0 flex-col gap-2" key={item.sourceHash}>
          <button type="button" className={`${formSecondaryButtonClass} self-start`} data-testid="artifact-external-figure" onClick={() => {
            if (busy.current || status.isLocked()) return;
            busy.current = true;
            void figure.run(item).then(result => {busy.current = false; if (result.ok) setSources(previous => ({...previous, [item.sourceHash]: result.data.sourcePath}));});
          }}>生成绘图源（{item.unit}）</button>
          {sources[item.sourceHash] === undefined ? null : <p className="break-all text-muted" data-testid="artifact-external-figure-path">{sources[item.sourceHash]}</p>}
        </div>)}
      </fieldset>
    </>}
    {[read.error, derive.error, capture.error, figure.error].filter(error => error !== null).map((error, index) => <p key={index} role="alert" className="text-[var(--st-warn)]">{error}</p>)}
  </section>;
}
