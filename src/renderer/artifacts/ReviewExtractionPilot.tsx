import {useEffect, useRef, useState} from 'react';
import type {ResearchReviewFullTextFrozenPhase} from '../../shared/schemas/research-review-fulltext-screening';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewPilotCell, ResearchReviewPilotReport} from '../../shared/schemas/research-review-pilot';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const states: Record<ResearchReviewPilotCell['status'], string> = {
  recorded: '已记录', missing: '未找到', unjudgeable: '无法判断', unextracted: '未试填', stale: '来源待重核'
};

export function ReviewExtractionPilot({client, protocol, phase, locked}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; phase: ResearchReviewFullTextFrozenPhase; locked: boolean;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [report, setReport] = useState<ResearchReviewPilotReport | null>(null);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const {projectId, corpusId} = phase.plan.snapshot.request;
  const read = useAsyncAction(() => client.api.research.inspectReviewExtractionPilot({projectId, corpusId,
    expectedFullFreezeHash: phase.freezeHash!, expectedProtocolVersionHash: protocol.versionHash,
    hitIds: selected, expectedReportHash: null}), {label: '核对少量报告的提取字段'});
  const included = phase.freeze?.authority.items.filter(item => item.status === 'included') ?? [];
  return <section className="flex min-w-0 flex-col gap-2" aria-label="提取字段试跑" data-testid="artifact-review-pilot">
    <h3 className="font-medium">提取字段试跑</h3>
    <p className="text-muted">选择 1–5 份纳入报告，核对现有提取中的缺项、单位和判读问题。填写仍使用下方原有表单。</p>
    <fieldset className="flex min-w-0 flex-col gap-2" disabled={locked || read.pending}>
      <legend className="sr-only">少量纳入报告</legend>
      {included.map((item, index) => <label key={item.hit.id} className="flex items-start gap-2 break-words">
        <input type="checkbox" className="mt-1" checked={selected.includes(item.hit.id)}
          disabled={!selected.includes(item.hit.id) && selected.length >= 5}
          onChange={event => {read.reset(); setReport(null); setSelected(current => event.target.checked ? [...current, item.hit.id] : current.filter(id => id !== item.hit.id));}}/>
        <span>纳入报告 {index + 1}，原始命中 {item.hit.recordIndex + 1}</span>
      </label>)}
    </fieldset>
    <button type="button" className={`${button} self-start`} data-testid="artifact-review-pilot-read"
      disabled={locked || read.pending || selected.length === 0 || phase.freezeHash === null}
      onClick={() => {setReport(null); void read.run().then(result => {if (mounted.current && result.ok) setReport(result.data);});}}>核对所选报告</button>
    {read.pending ? <p role="status">正在核对冻结字段、当前全文和提取来源…</p> : null}
    {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
    {report === null ? null : <div className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-pilot-report">
      <p className="text-muted" role="status">{report.status === 'stale' ? '版本已变化，请重新核对协议。' :
        report.attentionRequired ? '试跑仍有待处理项。' : '所选报告的已保存字段已完成当前来源核对。'}人工科学判断仍需逐项审阅。</p>
      {report.samples.map(sample => <section key={sample.hitId} className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h4 className="break-words font-medium">{sample.title}</h4>
        <p className="text-muted">{sample.sourceStatus === 'byte_checked' ? '当前文件已核对' : '当前来源尚未核实'}，
          {sample.extraction === null ? '尚无提取记录' : '读取已保存提取'}</p>
        <ul className="flex min-w-0 flex-col gap-2">{[sample.studyDesign, ...sample.fields].map(field => <li key={field.fieldId} className="break-words">
          <p>{field.label}{field.unit === null ? '' : `（${field.unit}）`}：{states[field.status]}{field.required ? '，必填' : ''}</p>
          {field.value?.kind === 'number' ? <p className="tabular-nums">{field.value.number}</p> : null}
          {field.value?.kind === 'text' ? <p className="whitespace-pre-wrap">{field.value.text}</p> : null}
          {field.reason === null ? null : <p className="text-muted whitespace-pre-wrap">{field.reason}</p>}
        </li>)}</ul>
      </section>)}
      {report.nextActions.length === 0 ? null : <section className="flex min-w-0 flex-col gap-1">
        <h4 className="font-medium">接下来</h4>
        <ul className="flex min-w-0 flex-col gap-1">{report.nextActions.map((action, index) =>
          <li key={index} className="break-words text-muted">{action.detail}</li>)}</ul>
      </section>}
    </div>}
  </section>;
}
