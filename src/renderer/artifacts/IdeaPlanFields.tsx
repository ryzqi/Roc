import type {ResearchIdeaPlanBody} from '../../shared/schemas/research-idea-plans';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';

const input = `${formInputClass} border-[0.5px]`;
const button = `${formSecondaryButtonClass} border-[0.5px] self-start`;
const ids = (value: string): string[] => value.split(',').map(id => id.trim()).filter(id => id.length > 0);

export function PlanText({label, value, onChange, required = true, rows = 2}: {
  label: string; value: string; onChange: (value: string) => void; required?: boolean; rows?: number
}): React.JSX.Element {
  return <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
    <textarea aria-label={label} required={required} maxLength={4000} rows={rows}
      className={`${input} h-auto resize-y py-1`} value={value} onChange={event => onChange(event.target.value)}/>
  </label>;
}

export function IdeaPlanFields({body, parameters, onParameters, onChange, disabled, observationChoice, onObservationChoice}: {
  body: ResearchIdeaPlanBody; parameters: string; onParameters: (value: string) => void;
  observationChoice: ResearchIdeaPlanBody['observation']['kind'] | ''; onObservationChoice: (value: ResearchIdeaPlanBody['observation']['kind'] | '') => void;
  onChange: (body: ResearchIdeaPlanBody) => void; disabled: boolean
}): React.JSX.Element {
  const update = (change: Partial<ResearchIdeaPlanBody>): void => onChange({...body, ...change});
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-col gap-1"><span className="text-muted">Canvas 假设</span>
      <p className="break-words text-ink" data-testid="artifact-idea-plan-hypothesis">{body.hypothesis}</p>
    </div>
    <PlanText label="可证伪条件" value={body.falsifiableIf} onChange={falsifiableIf => update({falsifiableIf})}/>
    <section className="flex min-w-0 flex-col gap-2" aria-label="计划指标">
      <h3 className="font-medium">指标与预期结果</h3>
      {body.metrics.map((metric, index) => <div key={index} className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        {(['id', 'label', 'definition', 'unit', 'expectedOutcome'] as const).map((key, at) =>
          <PlanText key={key} label={`指标 ${index + 1} ${['ID', '名称', '定义', '单位', '预期结果'][at]}`}
            value={metric[key]} rows={key === 'definition' || key === 'expectedOutcome' ? 2 : 1}
            onChange={value => update({metrics: body.metrics.map((item, i) => i === index ? {...item, [key]: value} : item)})}/>)}
        <label className="flex flex-col gap-1 text-muted">指标 {index + 1} 方向
          <select aria-label={`指标 ${index + 1} 方向`} className={input} value={metric.direction}
            onChange={event => update({metrics: body.metrics.map((item, i) => i === index ?
              {...item, direction: event.target.value as typeof metric.direction} : item)})}>
            <option value="higher">越高越好</option><option value="lower">越低越好</option><option value="neutral">无优劣方向</option>
          </select>
        </label>
        <button type="button" className={button} disabled={body.metrics.length === 1}
          onClick={() => update({metrics: body.metrics.filter((_, i) => i !== index)})}>移除指标 {index + 1}</button>
      </div>)}
      <button type="button" className={button} disabled={body.metrics.length >= 100} onClick={() => update({
        metrics: [...body.metrics, {id: '', label: '', definition: '', unit: '', direction: 'neutral', expectedOutcome: ''}]
      })}>添加指标</button>
    </section>
    <PlanText label="数据计划" value={body.dataPlan} onChange={dataPlan => update({dataPlan})}/>
    <PlanText label="实验设计" value={body.design} onChange={design => update({design})}/>
    <PlanText label="分析计划" value={body.analysisPlan} onChange={analysisPlan => update({analysisPlan})}/>
    <label className="flex flex-col gap-1 text-muted">观察时序声明
      <select aria-label="观察时序声明" required className={input} value={observationChoice}
        onChange={event => {
          const value = event.target.value as typeof observationChoice;
          onObservationChoice(value);
          if (value !== '') update({observation: value === 'before_data' ? {kind: 'before_data'} : {kind: 'after_data', evidenceIds: []}});
        }}>
        <option value="">请选择此版本的观察时序</option>
        <option value="before_data">观察数据前计划</option><option value="after_data">观察数据后计划</option>
      </select>
    </label>
    <p className="text-muted">时序由人工声明，不构成独立预注册证明。</p>
    {body.observation.kind === 'before_data' ? null : <PlanText label="已观察证据 ID（逗号分隔）"
      value={body.observation.evidenceIds.join(', ')} onChange={value => update({observation: {kind: 'after_data', evidenceIds: ids(value)}})}/>}
    <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" aria-label="待核查新颖性">
      <h3 className="font-medium">新颖性与研究空白：待核查推断</h3>
      <PlanText label="新颖性检索范围" value={body.novelty.searchScope}
        onChange={searchScope => update({novelty: {...body.novelty, searchScope}})}/>
      {body.novelty.comparisons.map((comparison, index) => <div key={index} className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2">
        {(['evidenceId', 'similarities', 'differences'] as const).map((key, at) =>
          <PlanText key={key} label={`对比 ${index + 1} ${['证据 ID', '相似之处', '差异'][at]}`} value={comparison[key]}
            onChange={value => update({novelty: {...body.novelty,
              comparisons: body.novelty.comparisons.map((item, i) => i === index ? {...item, [key]: value} : item)}})}/>)}
        <button type="button" className={button} onClick={() => update({novelty: {...body.novelty,
          comparisons: body.novelty.comparisons.filter((_, i) => i !== index)}})}>移除对比 {index + 1}</button>
      </div>)}
      <button type="button" className={button} disabled={body.novelty.comparisons.length >= 100}
        onClick={() => update({novelty: {...body.novelty,
          comparisons: [...body.novelty.comparisons, {evidenceId: '', similarities: '', differences: ''}]}})}>添加文献对比</button>
    </section>
    <label className="flex flex-col gap-1 text-muted">样本量与功效
      <select aria-label="样本量与功效" className={input} value={body.sampleSize.kind}
        onChange={event => update({sampleSize: event.target.value === 'not_calculated' ? {kind: 'not_calculated', reason: ''} :
          {kind: 'calculated', method: '', parameters: {}, value: Number.NaN, evidenceIds: [], reviewNote: ''}})}>
        <option value="not_calculated">尚未计算</option><option value="calculated">记录已审核计算</option>
      </select>
    </label>
    {body.sampleSize.kind === 'not_calculated' ? <PlanText label="未计算原因" value={body.sampleSize.reason}
      onChange={reason => update({sampleSize: {kind: 'not_calculated', reason}})}/> : <>
      <PlanText label="样本量计算方法" value={body.sampleSize.method} onChange={method => {
        if (body.sampleSize.kind === 'calculated') update({sampleSize: {...body.sampleSize, method}});
      }}/>
      <PlanText label="计算参数（每行名称=值）" value={parameters} onChange={onParameters}/>
      <label className="flex flex-col gap-1 text-muted">已审核样本量
        <input aria-label="已审核样本量" type="number" min={1} step={1} required className={input}
          value={Number.isFinite(body.sampleSize.value) ? body.sampleSize.value : ''} onChange={event => {
            if (body.sampleSize.kind === 'calculated') update({sampleSize: {...body.sampleSize, value: event.target.valueAsNumber}});
          }}/>
      </label>
      <PlanText label="功效计算证据 ID（逗号分隔）" required={false} value={body.sampleSize.evidenceIds.join(', ')}
        onChange={value => {if (body.sampleSize.kind === 'calculated') update({sampleSize: {...body.sampleSize, evidenceIds: ids(value)}});}}/>
      <PlanText label="功效计算审核说明" value={body.sampleSize.reviewNote}
        onChange={reviewNote => {if (body.sampleSize.kind === 'calculated') update({sampleSize: {...body.sampleSize, reviewNote}});}}/>
    </>}
  </fieldset>;
}
