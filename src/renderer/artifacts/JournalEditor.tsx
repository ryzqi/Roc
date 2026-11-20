import {useEffect, useRef, useState} from 'react';
import {researchJournalSelectionSchema, researchJournalSaveSchema, type ResearchJournalInspection,
  type ResearchJournalSave, type ResearchJournalInspect} from '../../shared/schemas/research-journal-compliance';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formTextAreaClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {JournalRuleEditor, journalRuleDraft, journalRuleInput, journalLines} from './JournalRuleEditor';
import {journalStatusLabels} from './JournalReceipt';

const input = `${formInputClass} border-[0.5px]`, textarea = `${formTextAreaClass} border-[0.5px] font-sans`;
export function JournalEditor({client, report, writable, onDirty, onPending, onSaved}: {
  client: RocClient; report: ResearchJournalInspection['report']; writable: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const initial = report.selection;
  const initialProfile = initial?.profile;
  const [profile, setProfile] = useState(() => ({journal: initialProfile?.journal ?? '', articleType: initialProfile?.articleType ?? '',
    submissionStage: initialProfile?.submissionStage ?? '', version: initialProfile?.version ?? '', revisionDate: initialProfile?.revisionDate ?? '',
    dateAuthority: initialProfile?.dateAuthority ?? '', retrievedAt: initialProfile?.retrievedAt ?? ''}));
  const initialRules = () => initial?.profile.rules.map(rule =>
    journalRuleDraft(rule, initial.manualReviews.find(review => review.ruleId === rule.id))) ?? [];
  const [rules, setRules] = useState(initialRules), [selected, setSelected] = useState(initial?.profile.rules[0]?.id ?? '');
  const [figureIds, setFigureIds] = useState(initial?.figureIds ?? []), [paths, setPaths] = useState(initial?.supplementPaths.join('\n') ?? '');
  const [rationale, setRationale] = useState(''), [dirty, setDirty] = useState(false), [validation, setValidation] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResearchJournalInspection | null>(null);
  const requestId = useRef(crypto.randomUUID()), busy = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const inspect = useAsyncAction((request: ResearchJournalInspect) => client.api.research.inspectJournalCompliance(request), {label: '预览投稿检查'});
  const save = useAsyncAction((request: ResearchJournalSave) => client.api.research.saveJournalCompliance(request), {label: '保存投稿检查'});
  const figures = useAsyncResource(`journal:figures:${report.projectId}:${report.artifactId}:${report.artifactVersion}`,
    () => client.api.research.listFigures({projectId: report.projectId, limit: 200}), {label: '读取项目图稿'});
  const pending = inspect.pending || save.pending, rule = rules.find(value => value.id === selected);
  const change = (): void => {
    setDirty(true); onDirty(true); setPreview(null); setValidation(null); requestId.current = crypto.randomUUID(); inspect.reset(); save.reset();
  };
  const finish = (): boolean => {
    busy.current = false;
    if (!mounted.current) return false;
    onPending(false);
    return true;
  };
  const profileText = (field: keyof typeof profile, label: string, type = 'text'): React.JSX.Element =>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
      <input required aria-label={label} className={input} type={type} value={profile[field]}
        onChange={event => {setProfile(previous => ({...previous, [field]: event.target.value})); change();}}/>
    </label>;
  return <form className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-journal-editor"
    onSubmit={event => {
      event.preventDefault();
      if (!writable || busy.current) return;
      const parent = report.review;
      const parsed = researchJournalSaveSchema.safeParse({
        projectId: report.projectId, artifactId: report.artifactId, expectedArtifactVersion: report.artifactVersion,
        requestId: requestId.current, parent: parent === null ? null : {reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash},
        expectedMaterialHash: preview?.report.materialHash, selection: preview?.report.selection, rationale
      });
      if (!parsed.success || preview?.report.artifactVersion !== report.artifactVersion || preview.status !== 'current') {
        setValidation('请先检查完整规则与当前材料，并填写修订理由。'); return;
      }
      busy.current = true; onPending(true);
      void save.run(parsed.data).then(reply => {
        if (!finish()) return;
        if (reply.ok) {setDirty(false); onDirty(false); onSaved();}
      });
    }}>
    <fieldset disabled={!writable || pending} className="flex min-w-0 flex-col gap-3">
      {profileText('journal', '期刊名称')}
      {profileText('articleType', '文章类型')}
      {profileText('submissionStage', '投稿阶段')}
      {profileText('version', '规则版本')}
      {profileText('revisionDate', '规则日期', 'date')}
      <label className="flex min-w-0 flex-col gap-1 text-muted">日期来源
        <select required aria-label="日期来源" className={input} value={profile.dateAuthority}
          onChange={event => {setProfile(previous => ({...previous, dateAuthority: event.target.value})); change();}}>
          <option value="">请选择</option><option value="official">官方日期</option><option value="human_transcription">人工整理日期</option>
        </select>
      </label>
      {profileText('retrievedAt', '资料获取时间（ISO 8601，含时区）')}
      <label className="flex min-w-0 flex-col gap-1 text-muted">选择规则
        <select aria-label="选择规则" className={input} value={selected} onChange={event => setSelected(event.target.value)}>
          <option value="">请选择</option>{rules.map(value => <option key={value.id} value={value.id}>{value.label || '未命名规则'}</option>)}
        </select>
      </label>
      <button type="button" className={`${formSecondaryButtonClass} self-start`} disabled={rules.length >= 200}
        data-testid="artifact-journal-rule-new" onClick={() => {
          const value = journalRuleDraft(); setRules(previous => [...previous, value]); setSelected(value.id); change();
        }}>添加规则</button>
      {rule === undefined ? null : <>
        <JournalRuleEditor draft={rule} onChange={value => {setRules(previous => previous.map(item => item.id === value.id ? value : item)); change();}}/>
        <button type="button" className={`${formSecondaryButtonClass} self-start`} data-testid="artifact-journal-rule-remove"
          onClick={() => {setRules(previous => previous.filter(value => value.id !== rule.id)); setSelected(''); change();}}>移除这条规则</button>
      </>}
      <fieldset className="flex min-w-0 flex-col gap-2" data-testid="artifact-journal-figures">
        <legend className="text-muted">所选图稿</legend>
        {figures.status === 'loading' ? <p role="status">正在读取图稿…</p> : null}
        {figures.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{figures.error}</p>}
        {figures.status !== 'ready' || figures.data === null ? null : <>
          {figures.data.filter(figure => figure.status !== 'superseded').map(figure =>
            <label className="flex min-w-0 items-start gap-2 break-words" key={figure.id}>
              <input type="checkbox" aria-label={`选择图稿 ${figure.id}`} checked={figureIds.includes(figure.id)}
                onChange={event => {setFigureIds(previous => event.target.checked ? [...previous, figure.id] : previous.filter(id => id !== figure.id)); change();}}/>
              <span className="min-w-0 break-words">{figure.title}，{figure.status === 'approved' ? '已批准' : '已绘制'}</span>
            </label>)}
          {figures.data.length < 200 ? null : <p className="text-muted">当前列出最近 200 个图稿。</p>}
          {figureIds.filter(id => !figures.data!.some(figure => figure.id === id && figure.status !== 'superseded')).map(id =>
            <label className="flex items-start gap-2 break-all" key={id}><input type="checkbox" checked aria-label={`移除失效图稿 ${id}`}
              onChange={() => {setFigureIds(previous => previous.filter(value => value !== id)); change();}}/>已选图稿需重新核对：{id}</label>)}
        </>}
      </fieldset>
      <label className="flex min-w-0 flex-col gap-1 text-muted">所选补充文件相对路径（每行一个）
        <textarea rows={3} aria-label="所选补充文件相对路径（每行一个）" className={textarea} value={paths}
          onChange={event => {setPaths(event.target.value); change();}}/>
      </label>
      <button type="button" className={`${formSecondaryButtonClass} self-start`} data-testid="artifact-journal-preview" onClick={() => {
        if (!writable || busy.current) return;
        const parsed = researchJournalSelectionSchema.safeParse({
          profile: {...profile, rules: rules.map(journalRuleInput)}, figureIds, supplementPaths: journalLines(paths),
          manualReviews: rules.filter(value => value.kind === 'manual' && (value.decision !== '' || value.rationale !== ''))
            .map(value => ({ruleId: value.id, decision: value.decision, rationale: value.rationale}))
        });
        setPreview(null);
        if (!parsed.success) {setValidation('填写完整期刊、版本、日期和规则来源；检查类型、要求性质及人工判断须明确选择。'); return;}
        setValidation(null); busy.current = true; onPending(true);
        void inspect.run({projectId: report.projectId, artifactId: report.artifactId, selection: parsed.data, expectedHash: null}).then(reply => {
          if (!finish() || !reply.ok) return;
          if (reply.data.report.artifactVersion !== report.artifactVersion) {setValidation('工件已变化，请放弃修改并刷新工件。'); return;}
          setPreview(reply.data);
        });
      }}>检查规则与材料</button>
      {preview === null ? null : <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-journal-preview-result">
        <p className="break-all text-muted">材料 SHA-256：{preview.report.materialHash}</p>
        <ul className="flex min-w-0 flex-col gap-2">{preview.report.checks.map(check =>
          <li className="break-words" key={check.ruleId}>{preview.report.selection!.profile.rules.find(value => value.id === check.ruleId)!.label}：
            {journalStatusLabels[check.status]}。{check.detail}
            {check.subjectIds.length === 0 ? null : <p className="break-all">{check.subjectIds.join('，')}</p>}
          </li>)}</ul>
      </section>}
      <label className="flex min-w-0 flex-col gap-1 text-muted">投稿检查修订理由
        <textarea required rows={3} maxLength={12000} aria-label="投稿检查修订理由" className={textarea} value={rationale}
          onChange={event => {setRationale(event.target.value); setDirty(true); onDirty(true);
            requestId.current = crypto.randomUUID(); save.reset(); setValidation(null);}}/>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={formPrimaryButtonClass} disabled={preview === null} data-testid="artifact-journal-save">保存投稿检查</button>
        <button type="button" className={formSecondaryButtonClass} disabled={!dirty} data-testid="artifact-journal-discard" onClick={() => {
          setProfile({journal: initialProfile?.journal ?? '', articleType: initialProfile?.articleType ?? '',
            submissionStage: initialProfile?.submissionStage ?? '', version: initialProfile?.version ?? '', revisionDate: initialProfile?.revisionDate ?? '',
            dateAuthority: initialProfile?.dateAuthority ?? '', retrievedAt: initialProfile?.retrievedAt ?? ''});
          setRules(initialRules()); setSelected(initial?.profile.rules[0]?.id ?? ''); setFigureIds(initial?.figureIds ?? []);
          setPaths(initial?.supplementPaths.join('\n') ?? ''); setRationale(''); setDirty(false); onDirty(false);
          setPreview(null); setValidation(null); requestId.current = crypto.randomUUID(); inspect.reset(); save.reset();
        }}>放弃投稿检查修改</button>
      </div>
    </fieldset>
    {!writable ? <p className="text-muted">当前工件只读。</p> : null}
    {pending ? <p role="status">正在核对或保存投稿检查，请等待回执。</p> : null}
    {validation === null ? null : <p role="alert" className="text-[var(--st-warn)]">{validation}</p>}
    {inspect.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{inspect.error}</p>}
    {save.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
  </form>;
}
