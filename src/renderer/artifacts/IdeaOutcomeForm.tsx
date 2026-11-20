import {useEffect, useRef, useState} from 'react';
import type {ResearchIdeaPlanInspection} from '../../shared/schemas/research-idea-plans';
import type {ResearchIdeaOutcomeHead, ResearchIdeaOutcomeSave} from '../../shared/schemas/research-idea-outcomes';
import {researchIdeaOutcomeSaveSchema} from '../../shared/schemas/research-idea-outcomes';
import type {ResearchExperimentResultReceipt} from '../../shared/schemas/research-experiment-results';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {PlanText} from './IdeaPlanFields';
import {outcomeVerdicts} from './IdeaOutcomeReceipt';
import {ExperimentResultReceipt} from './production/ExperimentResultReceipt';

type Choice = {metricId: string; reason: string};
const input = `${formInputClass} border-[0.5px]`;

export function IdeaOutcomeForm({client, plan, result, parent, writable, locked, onDirty, onPending, onSaved}: {
  client: RocClient; plan: ResearchIdeaPlanInspection; result: ResearchExperimentResultReceipt;
  parent: ResearchIdeaOutcomeHead | null; writable: boolean; locked: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const [choices, setChoices] = useState<Choice[]>(() => plan.version.request.body.metrics.map(() => ({metricId: '', reason: ''})));
  const [verdict, setVerdict] = useState<ResearchIdeaOutcomeSave['verdict'] | ''>('');
  const [reviewNote, setReviewNote] = useState('');
  const [revisionReason, setRevisionReason] = useState('');
  const [validation, setValidation] = useState<string[]>([]);
  const [captured, setCaptured] = useState<string[]>([]);
  const requestId = useRef(crypto.randomUUID()), busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const save = useAsyncAction(async (request: ResearchIdeaOutcomeSave) => {
    const metrics: ResearchIdeaOutcomeSave['metrics'] = [];
    for (const mapping of request.metrics) {
      if (mapping.kind === 'missing') {metrics.push(mapping); continue;}
      const capture = await client.api.research.captureExperimentResultEvidence({
        projectId: request.projectId, ...request.result, metricId: mapping.evidenceId
      });
      if (!capture.ok) return capture;
      if (mounted.current) setCaptured(ids => ids.includes(capture.data.id) ? ids : [...ids, capture.data.id]);
      metrics.push({...mapping, evidenceId: capture.data.id});
    }
    return client.api.research.saveIdeaOutcome({...request, metrics});
  }, {label: '关联指标证据并保存评估'});
  const change = (): void => {requestId.current = crypto.randomUUID(); onDirty(true); setValidation([]); save.reset();};
  const differences = plan.version.request.body.metrics.flatMap((planned, index) => {
    const choice = choices[index];
    if (choice.metricId === '') return [];
    if (choice.metricId === '__missing') return [`${planned.label}：缺失指标`];
    const actual = result.snapshot.request.definitions.find(metric => metric.id === choice.metricId.slice(7))!;
    const fields = (['definition', 'unit', 'direction'] as const).filter(field => planned[field] !== actual[field]);
    return fields.length === 0 ? [] : [`${planned.label}：${fields.map(field => ({definition: '定义', unit: '单位', direction: '方向'})[field]).join('、')}`];
  });
  return <form className="flex min-w-0 flex-col gap-3" data-testid="artifact-idea-outcome-form" onSubmit={event => {
    event.preventDefault();
    if (!writable || locked || busy.current) return;
    if (choices.some(choice => choice.metricId === '')) {setValidation(['请逐项选择实测指标或填写缺失原因。']); return;}
    if ((differences.length > 0) !== (verdict === 'not_comparable')) {
      setValidation([differences.length > 0 ? '指标存在差异，请选择不可比并说明原因。' : '指标无可比性差异，请选择支持、反驳或结果不确定。']); return;
    }
    const parsed = researchIdeaOutcomeSaveSchema.safeParse({
      projectId: plan.version.request.projectId, artifactId: plan.version.request.artifactId, requestId: requestId.current,
      plan: {versionId: plan.version.id, versionHash: plan.versionHash, freezeHash: plan.freezeHash},
      result: {resultId: result.snapshot.id, expectedHash: result.snapshotHash},
      metrics: choices.map((choice, index) => choice.metricId === '__missing' ?
        {kind: 'missing', plannedMetricId: plan.version.request.body.metrics[index].id, reason: choice.reason} :
        {kind: 'measured', plannedMetricId: plan.version.request.body.metrics[index].id, evidenceId: choice.metricId.slice(7)}),
      verdict, reviewNote, parent: parent === null ? null : {outcomeId: parent.outcomeId, outcomeHash: parent.outcomeHash},
      revisionReason: parent === null ? null : revisionReason
    });
    if (!parsed.success) {setValidation(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)); return;}
    busy.current = true; onPending(true);
    void save.run(parsed.data).then(reply => {
      busy.current = false;
      if (!mounted.current) return;
      onPending(false);
      if (reply.ok) {onDirty(false); onSaved();}
    });
  }}>
    <ExperimentResultReceipt receipt={result}/>
    <fieldset disabled={!writable || locked || save.pending} className="flex min-w-0 flex-col gap-3">
      {plan.version.request.body.metrics.map((planned, index) => <section key={planned.id}
        className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium break-words">{planned.label} {planned.id}</h3>
        <p className="break-words">{planned.definition}，{planned.unit}，{{higher: '越高越好', lower: '越低越好', neutral: '无优劣方向'}[planned.direction]}</p>
        <p className="break-words">预期结果：{planned.expectedOutcome}</p>
        <label className="flex min-w-0 flex-col gap-1 text-muted">{planned.label} 实测指标
          <select aria-label={`${planned.label} 实测指标`} required className={input} value={choices[index].metricId}
            onChange={event => {setChoices(choices.map((item, at) => at === index ? {...item, metricId: event.target.value} : item)); change();}}>
            <option value="">请选择实测指标或缺失</option>
            {result.snapshot.request.definitions.map(metric => <option key={metric.id} value={`metric:${metric.id}`}>{metric.label} {metric.id} {metric.unit}</option>)}
            <option value="__missing">此结果缺失该指标</option>
          </select>
        </label>
        {choices[index].metricId !== '__missing' ? null : <PlanText label={`${planned.label} 缺失原因`} value={choices[index].reason}
          onChange={reason => {setChoices(choices.map((item, at) => at === index ? {...item, reason} : item)); change();}}/>}
      </section>)}
      {differences.length === 0 ? null : <ul className="break-words text-[var(--st-warn)]" data-testid="artifact-idea-outcome-differences">
        {differences.map(value => <li key={value}>{value}</li>)}
      </ul>}
      <label className="flex min-w-0 flex-col gap-1 text-muted">人工结果评估
        <select aria-label="人工结果评估" required className={input} value={verdict}
          onChange={event => {setVerdict(event.target.value as typeof verdict); change();}}>
          <option value="">请选择人工判断</option>
          {Object.entries(outcomeVerdicts).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
      </label>
      <PlanText label="结果评估审核说明" value={reviewNote} onChange={value => {setReviewNote(value); change();}}/>
      {parent === null ? null : <PlanText label="结果评估修订原因" value={revisionReason} onChange={value => {setRevisionReason(value); change();}}/>}
    </fieldset>
    {validation.length === 0 ? null : <ul role="alert" className="break-words text-[var(--st-warn)]">
      {validation.map((issue, index) => <li key={index}>{issue}</li>)}
    </ul>}
    {save.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
    {captured.length === 0 ? null : <p role="status" className="break-all text-muted">
      已保存指标证据 {captured.join('、')}。评估失败时这些证据仍保留。
    </p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px]`} disabled={!writable || locked || save.pending}
        data-testid="artifact-idea-outcome-save">{save.pending ? '正在保存…' : '关联指标证据并保存评估'}</button>
      <button type="button" className={`${formSecondaryButtonClass} border-[0.5px]`} disabled={locked || save.pending}
        data-testid="artifact-idea-outcome-discard" onClick={() => {
          setChoices(plan.version.request.body.metrics.map(() => ({metricId: '', reason: ''})));
          setVerdict(''); setReviewNote(''); setRevisionReason(''); setValidation([]); save.reset();
          requestId.current = crypto.randomUUID(); onDirty(false);
        }}>放弃未保存评估</button>
    </div>
  </form>;
}
