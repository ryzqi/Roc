import type {ResearchReviewQualityPlanCreate} from '../../shared/schemas/research-review-quality';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';

type Definition = ResearchReviewQualityPlanCreate['definition'];
export type QualityDomainDraft = Definition['domains'][number] & {key: string};
const input = `${formInputClass} border-[0.5px]`;
const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function blankQualityDomain(): QualityDomainDraft {
  return {key: crypto.randomUUID(), id: '', label: '', question: '', judgements: ['', '']};
}
export function ReviewQualityChoices({label, values, onChange}: {
  label: string; values: string[]; onChange: (values: string[]) => void
}): React.JSX.Element {
  return <section className="flex min-w-0 flex-col gap-2">
    <h4 className="font-medium">{label}</h4>
    {values.map((value, index) => <div key={index} className="flex items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-muted">{label} {index + 1}
        <input required maxLength={300} aria-label={`${label} ${index + 1}`} className={input} value={value}
          onChange={event => onChange(values.map((item, position) => position === index ? event.target.value : item))} />
      </label>
      <button type="button" className={button} disabled={values.length <= 2} aria-label={`移除${label} ${index + 1}`}
        onClick={() => onChange(values.filter((_, position) => position !== index))}>移除</button>
    </div>)}
    <button type="button" className={`${button} self-start`} disabled={values.length >= 10}
      onClick={() => onChange([...values, ''])}>添加{label}</button>
  </section>;
}
export function ReviewQualityDefinition({domains, overall, documentationNote, onDomains, onOverall, onDocumentation}: {
  domains: QualityDomainDraft[]; overall: string[]; documentationNote: string;
  onDomains: (domains: QualityDomainDraft[]) => void; onOverall: (values: string[]) => void; onDocumentation: (note: string) => void
}): React.JSX.Element {
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-review-quality-definition">
    <label className="flex flex-col gap-1 text-muted">框架定义与文档依据
      <textarea required aria-label="框架定义与文档依据" maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
        value={documentationNote} onChange={event => onDocumentation(event.target.value)} />
    </label>
    {domains.map((domain, index) => {
      const label = `评价域 ${index + 1}`;
      const update = (next: QualityDomainDraft): void => onDomains(domains.map(item => item.key === domain.key ? next : item));
      return <section key={domain.key} className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium">{label}</h3>
        {([['ID', 'id'], ['名称', 'label']] as const).map(([suffix, field]) => <label key={field} className="flex flex-col gap-1 text-muted">
          {label}{suffix}<input required maxLength={300} aria-label={`${label}${suffix}`} className={input} value={domain[field]}
            onChange={event => update({...domain, [field]: event.target.value})} />
        </label>)}
        <label className="flex flex-col gap-1 text-muted">{label}问题
          <textarea required maxLength={10000} rows={3} aria-label={`${label}问题`} className={`${input} h-auto resize-y py-1`}
            value={domain.question} onChange={event => update({...domain, question: event.target.value})} />
        </label>
        <ReviewQualityChoices label={`${label}判断类别`} values={domain.judgements} onChange={judgements => update({...domain, judgements})} />
        <button type="button" className={`${button} self-start`} disabled={domains.length <= 1}
          aria-label={`移除${label}`} onClick={() => onDomains(domains.filter(item => item.key !== domain.key))}>移除此评价域</button>
      </section>;
    })}
    <button type="button" className={`${button} self-start`} disabled={domains.length >= 50}
      onClick={() => onDomains([...domains, blankQualityDomain()])}>添加评价域</button>
    <ReviewQualityChoices label="总体判断类别" values={overall} onChange={onOverall} />
  </section>;
}
