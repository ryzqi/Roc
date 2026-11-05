import type {ResearchJournalSelection} from '../../shared/schemas/research-journal-compliance';
import {formInputClass, formTextAreaClass} from '../shared/form-ui';

type Rule = ResearchJournalSelection['profile']['rules'][number];
export type JournalRuleDraft = {
  id: string; label: string; sourceUrl: string; excerpt: string; authority: string; kind: string;
  titles: string; maximum: string; fields: string[]; format: string; maximumBytes: string; minimumDpi: string;
  maximumWidthPoints: string; maximumHeightPoints: string; paths: string; area: string; decision: string; rationale: string;
};
export function journalRuleDraft(rule?: Rule, review?: ResearchJournalSelection['manualReviews'][number]): JournalRuleDraft {
  const draft = {id: rule?.id ?? crypto.randomUUID(), label: rule?.label ?? '', sourceUrl: rule?.sourceUrl ?? '',
    excerpt: rule?.excerpt ?? '', authority: rule?.authority ?? '', kind: rule?.kind ?? '', titles: '', maximum: '',
    fields: [] as string[], format: '', maximumBytes: '', minimumDpi: '', maximumWidthPoints: '', maximumHeightPoints: '',
    paths: '', area: '', decision: review?.decision ?? '', rationale: review?.rationale ?? ''};
  if (rule?.kind === 'sections') draft.titles = rule.titles.join('\n');
  if (rule?.kind === 'reference_count') draft.maximum = String(rule.maximum);
  if (rule?.kind === 'reference_fields') draft.fields = rule.fields;
  if (rule?.kind === 'figure_files') {
    draft.format = rule.format; draft.maximumBytes = String(rule.maximumBytes);
    draft.minimumDpi = rule.minimumDpi === null ? '' : String(rule.minimumDpi);
    draft.maximumWidthPoints = rule.maximumWidthPoints === null ? '' : String(rule.maximumWidthPoints);
    draft.maximumHeightPoints = rule.maximumHeightPoints === null ? '' : String(rule.maximumHeightPoints);
  }
  if (rule?.kind === 'supplements') draft.paths = rule.paths.join('\n');
  if (rule?.kind === 'manual') draft.area = rule.area;
  return draft;
}
export const journalLines = (value: string): string[] => value.split('\n').map(line => line.trim()).filter(Boolean);
const number = (value: string): number => value.trim() === '' ? NaN : Number(value);
const optionalNumber = (value: string): number | null => value.trim() === '' ? null : number(value);
export function journalRuleInput(draft: JournalRuleDraft): unknown {
  const common = {id: draft.id, label: draft.label, sourceUrl: draft.sourceUrl, excerpt: draft.excerpt,
    authority: draft.authority, kind: draft.kind};
  switch (draft.kind) {
    case 'sections': return {...common, titles: journalLines(draft.titles)};
    case 'reference_count': return {...common, maximum: number(draft.maximum)};
    case 'reference_fields': return {...common, fields: draft.fields};
    case 'figure_files': return {...common, format: draft.format, maximumBytes: number(draft.maximumBytes),
      minimumDpi: optionalNumber(draft.minimumDpi), maximumWidthPoints: optionalNumber(draft.maximumWidthPoints),
      maximumHeightPoints: optionalNumber(draft.maximumHeightPoints)};
    case 'supplements': return {...common, paths: journalLines(draft.paths)};
    case 'manual': return {...common, area: draft.area};
    default: return common;
  }
}
const input = `${formInputClass} border-[0.5px]`, textarea = `${formTextAreaClass} border-[0.5px] font-sans`;
export const journalKindLabels: Record<string, string> = {sections: '小节标题', reference_count: '引用数量',
  reference_fields: '引用字段', figure_files: '图稿文件', supplements: '补充材料', manual: '人工核对'};
export function JournalRuleEditor({draft, onChange}: {draft: JournalRuleDraft; onChange: (value: JournalRuleDraft) => void}): React.JSX.Element {
  const text = (key: keyof JournalRuleDraft, label: string, type = 'text', required = true): React.JSX.Element =>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
      <input aria-label={label} type={type} step={type === 'number' ? 'any' : undefined} required={required} className={input} value={String(draft[key])}
        onChange={event => onChange({...draft, [key]: event.target.value})}/>
    </label>;
  const select = (key: keyof JournalRuleDraft, label: string, values: Record<string, string>): React.JSX.Element =>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
      <select aria-label={label} required className={input} value={String(draft[key])}
        onChange={event => {
          const value = event.target.value;
          onChange(key === 'kind' ? {...journalRuleDraft(), id: draft.id, label: draft.label, sourceUrl: draft.sourceUrl,
            excerpt: draft.excerpt, authority: draft.authority, kind: value} : {...draft, [key]: value});
        }}>
        <option value="">请选择</option>
        {Object.entries(values).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select>
    </label>;
  const lines = (key: 'titles' | 'paths', label: string): React.JSX.Element =>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
      <textarea required rows={3} aria-label={label} className={textarea} value={draft[key]}
        onChange={event => onChange({...draft, [key]: event.target.value})}/>
    </label>;
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-journal-rule">
    {text('label', '规则名称')}
    {select('authority', '要求性质', {required: '硬性要求', guidance: '指导性建议'})}
    {text('sourceUrl', '规则来源 URL', 'url')}
    <label className="flex min-w-0 flex-col gap-1 text-muted">规则原文
      <textarea required rows={4} maxLength={12000} aria-label="规则原文" className={textarea} value={draft.excerpt}
        onChange={event => onChange({...draft, excerpt: event.target.value})}/>
    </label>
    {select('kind', '检查类型', journalKindLabels)}
    {draft.kind !== 'sections' ? null : lines('titles', '必需小节标题（每行一个）')}
    {draft.kind !== 'reference_count' ? null : text('maximum', '引用数量上限', 'number')}
    {draft.kind !== 'reference_fields' ? null : <fieldset className="flex flex-col gap-1">
      <legend className="text-muted">必需引用字段</legend>
      {Object.entries({title: '标题', authors: '作者', doi: 'DOI', publishedYear: '发表年份', url: 'URL'}).map(([value, label]) =>
        <label className="flex items-center gap-2" key={value}><input type="checkbox" checked={draft.fields.includes(value)}
          onChange={event => onChange({...draft, fields: event.target.checked ? [...draft.fields, value] : draft.fields.filter(field => field !== value)})}/>{label}</label>)}
    </fieldset>}
    {draft.kind !== 'figure_files' ? null : <>
      {select('format', '图稿格式', {png: 'PNG', svg: 'SVG', pdf: 'PDF'})}
      {text('maximumBytes', '文件字节上限', 'number')}
      {text('minimumDpi', '栅格最低 DPI（可留空）', 'number', false)}
      {text('maximumWidthPoints', '最大宽度 pt（可留空）', 'number', false)}
      {text('maximumHeightPoints', '最大高度 pt（可留空）', 'number', false)}
    </>}
    {draft.kind !== 'supplements' ? null : lines('paths', '必需补充文件相对路径（每行一个）')}
    {draft.kind !== 'manual' ? null : <>
      {select('area', '人工核对范围', {structure: '结构', references: '引用', figures: '图稿', supplements: '补充材料'})}
      <label className="flex flex-col gap-1 text-muted">人工判断
        <select aria-label="人工判断" className={input} value={draft.decision} onChange={event => onChange({...draft, decision: event.target.value})}>
          <option value="">尚未判断</option><option value="pass">通过</option><option value="fail">不通过</option><option value="not_applicable">不适用</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-muted">人工判断理由
        <textarea rows={3} maxLength={12000} aria-label="人工判断理由" className={textarea} value={draft.rationale}
          onChange={event => onChange({...draft, rationale: event.target.value})}/>
      </label>
    </>}
  </section>;
}
