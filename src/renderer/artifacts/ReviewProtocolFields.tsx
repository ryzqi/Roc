import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import type {ReviewProtocolBody} from './review-protocol-draft';

const input = `${formInputClass} border-[0.5px]`;
const button = `${formSecondaryButtonClass} border-[0.5px]`;
const sources: {value: ReviewProtocolBody['databases'][number]['source']; label: string}[] = [
  {value: 'openalex', label: 'OpenAlex'}, {value: 'crossref', label: 'Crossref'},
  {value: 'semantic_scholar', label: 'Semantic Scholar'}, {value: 'arxiv', label: 'arXiv'},
  {value: 'pubmed', label: 'PubMed'}, {value: 'europe_pmc', label: 'Europe PMC'}
];

function Text({label, value, onChange, multiline = false, required = true, maxLength = 10000}: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; required?: boolean; maxLength?: number
}): React.JSX.Element {
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-1">
    <label htmlFor={id} className="text-muted">{label}</label>
    {multiline ? <textarea id={id} required={required} maxLength={maxLength} value={value} rows={3}
      className={`${input} h-auto py-1 resize-y`} onChange={event => onChange(event.target.value)} /> :
      <input id={id} required={required} maxLength={maxLength} value={value} className={input} onChange={event => onChange(event.target.value)} />}
  </div>;
}

export function ReviewProtocolFields({body, onChange, disabled}: {
  body: ReviewProtocolBody; onChange: (body: ReviewProtocolBody) => void; disabled: boolean
}): React.JSX.Element {
  const set = <K extends keyof ReviewProtocolBody>(key: K, value: ReviewProtocolBody[K]): void => onChange({...body, [key]: value});
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-fields">
    <legend className="mb-2 font-medium">研究范围与方法</legend>
    <Text label="研究问题" value={body.question} multiline onChange={value => set('question', value)} />
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={body.pico !== null} onChange={event => set('pico', event.target.checked ?
        {population: '', intervention: '', comparator: '', outcome: ''} : null)} />使用 PICO
    </label>
    {body.pico === null ? null : <div className="form-grid">
      {([['population', '研究人群'], ['intervention', '干预'], ['comparator', '对照'], ['outcome', '结局']] as const).map(([key, label]) =>
        <Text key={key} label={label} value={body.pico![key]} onChange={value => set('pico', {...body.pico!, [key]: value})} />)}
    </div>}
    {([['inclusionCriteria', '纳入标准'], ['exclusionCriteria', '排除标准']] as const).map(([key, label]) =>
      <section key={key} className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" aria-label={label}>
        <h3 className="font-medium">{label}</h3>
        {body[key].map((criterion, index) => <div key={criterion.id} className="flex items-end gap-2">
          <div className="min-w-0 flex-1"><Text label={`${label} ${index + 1}`} value={criterion.text}
            onChange={value => set(key, body[key].map((item, at) => at === index ? {...item, text: value} : item))} /></div>
          <button type="button" className={button} disabled={body[key].length === 1} aria-label={`移除${label} ${index + 1}`}
            onClick={() => set(key, body[key].filter((_, at) => at !== index))}>移除</button>
        </div>)}
        <button type="button" className={`${button} self-start`} disabled={body[key].length >= 50}
          onClick={() => set(key, [...body[key], {id: crypto.randomUUID(), text: ''}])}>添加{label}</button>
      </section>)}
    <div className="form-grid">
      {([['from', '发表起始年'], ['to', '发表截止年']] as const).map(([key, label]) => <label key={key} className="flex flex-col gap-1 text-muted">
        {label}<input type="number" className={input} min={1000} max={9999} step={1} value={body.publicationYears[key] ?? ''}
          onChange={event => set('publicationYears', {...body.publicationYears, [key]: event.target.value === '' ? null : Number(event.target.value)})} />
      </label>)}
    </div>
    <section className="flex flex-col gap-3 border-t-[0.5px] border-line pt-2" aria-label="数据库检索式">
      <h3 className="font-medium">数据库检索式</h3>
      {body.databases.map((database, index) => {
        const update = (value: ReviewProtocolBody['databases'][number]): void =>
          set('databases', body.databases.map((item, at) => at === index ? value : item));
        return <section key={index} className="flex min-w-0 flex-col gap-2" aria-label={`数据库 ${index + 1}`}>
          <label className="flex flex-col gap-1 text-muted">数据库
            <select aria-label="数据库" value={database.source} className={input} onChange={event => update({...database,
              source: event.target.value as typeof database.source})}>
              {sources.map(source => <option key={source.value} value={source.value}
                disabled={body.databases.some((item, at) => at !== index && item.source === source.value)}>{source.label}</option>)}
            </select>
          </label>
          {database.queries.map((query, queryIndex) => <div key={queryIndex} className="flex items-end gap-2">
            <div className="min-w-0 flex-1"><Text label={`检索式 ${queryIndex + 1}`} value={query} maxLength={1000} multiline
              onChange={value => update({...database, queries: database.queries.map((item, at) => at === queryIndex ? value : item)})} /></div>
            <button type="button" className={button} disabled={database.queries.length === 1} aria-label={`移除检索式 ${queryIndex + 1}`}
              onClick={() => update({...database, queries: database.queries.filter((_, at) => at !== queryIndex)})}>移除</button>
          </div>)}
          <div className="form-grid">
            {([['pageSize', '每页记录数', 30], ['maxPages', '最多页数', 3]] as const).map(([key, label, max]) =>
              <label key={key} className="flex flex-col gap-1 text-muted">{label}
                <input type="number" required min={1} max={max} step={1} className={input} value={database[key]}
                  onChange={event => update({...database, [key]: Number(event.target.value)})} />
              </label>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={database.queries.length >= 3}
              onClick={() => update({...database, queries: [...database.queries, '']})}>添加检索式</button>
            <button type="button" className={button} disabled={body.databases.length === 1}
              onClick={() => set('databases', body.databases.filter((_, at) => at !== index))}>移除数据库</button>
          </div>
        </section>;
      })}
      <button type="button" className={`${button} self-start`} disabled={body.databases.length === sources.length} onClick={() => {
        const source = sources.find(candidate => !body.databases.some(database => database.source === candidate.value));
        if (source === undefined) throw new Error('research_review_database_limit');
        set('databases', [...body.databases, {source: source.value, queries: [''], pageSize: 10, maxPages: 1}]);
      }}>添加数据库</button>
    </section>
    <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" aria-label="人工筛选策略">
      <h3 className="font-medium">人工筛选策略</h3>
      <div className="form-grid">
        {([['titleAbstractReviewers', '标题摘要审核人数'], ['fullTextReviewers', '全文审核人数']] as const).map(([key, label]) =>
          <label key={key} className="flex flex-col gap-1 text-muted">{label}
            <select aria-label={label} className={input} value={body.screening[key]} onChange={event => set('screening',
              {...body.screening, [key]: Number(event.target.value) as 1 | 2})}>
              <option value={1}>一人</option><option value={2}>两人独立审核</option>
            </select>
          </label>)}
      </div>
      <p className="text-muted">冲突处理：人工仲裁</p>
    </section>
    <section className="flex flex-col gap-3 border-t-[0.5px] border-line pt-2" aria-label="质量评价框架">
      <h3 className="font-medium">质量评价框架</h3>
      {body.qualityAssessment.map((definition, index) => <div key={index} className="flex flex-col gap-2">
        <Text label={`研究设计 ${index + 1}`} value={definition.studyDesign} onChange={value => set('qualityAssessment',
          body.qualityAssessment.map((item, at) => at === index ? {...item, studyDesign: value} : item))} />
        <Text label={`评价框架 ${index + 1}`} value={definition.framework} onChange={value => set('qualityAssessment',
          body.qualityAssessment.map((item, at) => at === index ? {...item, framework: value} : item))} />
        <Text label={`框架版本 ${index + 1}`} value={definition.version} maxLength={300} onChange={value => set('qualityAssessment',
          body.qualityAssessment.map((item, at) => at === index ? {...item, version: value} : item))} />
        <button type="button" className={`${button} self-start`} disabled={body.qualityAssessment.length === 1}
          onClick={() => set('qualityAssessment', body.qualityAssessment.filter((_, at) => at !== index))}>移除框架</button>
      </div>)}
      <button type="button" className={`${button} self-start`} disabled={body.qualityAssessment.length >= 20}
        onClick={() => set('qualityAssessment', [...body.qualityAssessment, {studyDesign: '', framework: '', version: ''}])}>添加框架</button>
    </section>
    <section className="flex flex-col gap-3 border-t-[0.5px] border-line pt-2" aria-label="提取字段">
      <h3 className="font-medium">提取字段</h3>
      {body.extractionFields.map((field, index) => <div key={field.id} className="flex flex-col gap-2">
        <div className="form-grid">
          <Text label={`字段名称 ${index + 1}`} value={field.label} maxLength={300} onChange={value => set('extractionFields',
            body.extractionFields.map((item, at) => at === index ? {...item, label: value} : item))} />
          <Text label={`字段单位 ${index + 1}`} value={field.unit ?? ''} required={false} maxLength={300} onChange={value => set('extractionFields',
            body.extractionFields.map((item, at) => at === index ? {...item, unit: value === '' ? null : value} : item))} />
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={field.required}
            onChange={event => set('extractionFields', body.extractionFields.map((item, at) =>
              at === index ? {...item, required: event.target.checked} : item))} />必填</label>
          <button type="button" className={button} disabled={body.extractionFields.length === 1}
            onClick={() => set('extractionFields', body.extractionFields.filter((_, at) => at !== index))}>移除字段</button>
        </div>
      </div>)}
      <button type="button" className={`${button} self-start`} disabled={body.extractionFields.length >= 50}
        onClick={() => set('extractionFields', [...body.extractionFields, {id: crypto.randomUUID(), label: '', unit: null, required: true}])}>添加字段</button>
    </section>
  </fieldset>;
}
import {useId} from 'react';
