import {useRef, useState} from 'react';
import type {ResearchExportExecution} from '../../shared/schemas/research-exports';
import {isSubmissionExtraPath, researchSubmissionPrepareSchema, type ResearchSubmissionReceipt, type ResearchSubmissionPrepare} from '../../shared/schemas/research-submission';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {useArtifactEditorGuard} from './artifact-editor-guard';

const button = formSecondaryButtonClass;
const statusLabels = {preparing: '正在生成', ready: '已生成', failed: '失败', interrupted: '已中断'};
const checkLabels = {pass: '通过', fail: '不符合', manual: '需人工核对'};
const kindLabels = {pages: '页数', declarations: '必要声明', anonymity: '匿名处理', editable_tables: '可编辑表格', supplements: '补充材料', journal_rules: '期刊规则'};
type Callbacks = {onDirty: (dirty: boolean) => void; onPending: (pending: boolean) => void};

export function SubmissionPanel({client, record, writable, onDirty, onPending}: Callbacks & {
  client: RocClient; record: ResearchExportExecution; writable: boolean;
}): React.JSX.Element {
  const projectId = record.projectId, exportId = record.id;
  const [mode, setMode] = useState<'named' | 'anonymous'>('named'), [title, setTitle] = useState(record.request.title);
  const [profileId, setProfileId] = useState(''), [privateTerms, setPrivateTerms] = useState('');
  const [paths, setPaths] = useState<string[]>([]), [receipt, setReceipt] = useState<ResearchSubmissionReceipt | null>(null);
  const [offset, setOffset] = useState<number | null>(null), [selectionId, setSelectionId] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null), [profilesOffset, setProfilesOffset] = useState(0);
  const busy = useRef(false), requestId = useRef(crypto.randomUUID());
  const guard = useArtifactEditorGuard();
  const profiles = useAsyncResource(`submission:profiles:${projectId}:${profilesOffset}`,
    () => client.api.research.listSubmissionProfiles({projectId, offset: profilesOffset, limit: 10}), {label: '读取投稿配置'});
  const selectedProfile = profiles.data?.items.find(profile => profile.snapshot.id === profileId);
  const profile = useAsyncResource(selectedProfile === undefined ? null : `submission:profile:${profileId}:${selectedProfile.snapshotHash}`,
    () => client.api.research.getSubmissionProfile({projectId, versionId: profileId, expectedHash: selectedProfile!.snapshotHash}), {label: '核对配置版本'});
  const prepare = useAsyncAction((input: ResearchSubmissionPrepare) => client.api.research.prepareSubmission(input), {label: '生成投稿包'});
  const history = useAsyncResource(offset === null ? null : `submission:list:${projectId}:${offset}`,
    () => client.api.research.listSubmissions({projectId, offset: offset!, limit: 10}), {label: '读取投稿包'});
  const get = useAsyncResource(selectionId === null ? null : `submission:get:${projectId}:${selectionId}`,
    () => client.api.research.getSubmission({projectId, submissionId: selectionId!}), {label: '核对投稿包'});
  const current = selectionId === null ? receipt : get.status === 'ready' ? get.data : null;
  const change = (): void => {onDirty(true); requestId.current = crypto.randomUUID(); setValidation(null); prepare.reset(); setReceipt(null); setSelectionId(null);};
  const requirements = profile.status === 'ready' ? profile.data?.snapshot.request.requirements : null;
  const matchesMode = requirements !== null && requirements?.anonymous === (mode === 'anonymous');
  const active = prepare.pending;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" aria-label="期刊投稿包" data-testid="artifact-submission">
    <fieldset disabled={!writable || active} className="flex min-w-0 flex-col gap-3">
      <label className="flex flex-col gap-1 text-muted">投稿配置
        <select className={formInputClass} value={profileId} onChange={event => {setProfileId(event.target.value); change();}}>
          <option value="">选择确切配置版本</option>
          {profiles.data?.items.map(profile => <option key={profile.snapshot.id} value={profile.snapshot.id}>
            {profile.snapshot.request.profile.journal}，{profile.snapshot.request.profile.articleType}，版本 {profile.snapshot.version}
          </option>)}
        </select>
      </label>
      {profiles.data === null ? null : <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={profilesOffset === 0} onClick={() => {setProfilesOffset(profilesOffset - 10); setProfileId('');}}>上一页配置</button>
        <button type="button" className={button} disabled={profilesOffset + 10 >= profiles.data.total} onClick={() => {setProfilesOffset(profilesOffset + 10); setProfileId('');}}>下一页配置</button>
      </div>}
      <label className="flex flex-col gap-1 text-muted">投稿版本
        <select className={formInputClass} value={mode} onChange={event => {setMode(event.target.value as typeof mode); change();}}>
          <option value="named">署名版</option><option value="anonymous">匿名版</option>
        </select>
      </label>
      {requirements === null || matchesMode ? null : <p role="alert" className="text-[var(--st-warn)]">此配置要求{requirements?.anonymous ? '匿名版' : '署名版'}。</p>}
      <label className="flex flex-col gap-1 text-muted">投稿包标题
        <input className={formInputClass} maxLength={300} value={title} onChange={event => {setTitle(event.target.value); change();}}/>
      </label>
      {mode !== 'anonymous' ? null : <><label className="flex flex-col gap-1 text-muted">待替换的身份词（每行一项）
        <textarea className={`${formInputClass} h-auto resize-y py-2`} rows={4} maxLength={50000} autoComplete="off" value={privateTerms}
          onChange={event => {setPrivateTerms(event.target.value); change();}}/>
      </label><p className="text-muted">本次替换为 Anonymous，不写入公开回执。含数字的内容需另行核对。</p></>}
      {record.files.length === 0 ? null : <fieldset className="flex min-w-0 flex-col gap-2"><legend className="mb-2 text-muted">附加文件</legend>
        {record.files.filter(file => isSubmissionExtraPath(file.path)).map(file => <label key={file.path} className="flex items-start gap-2">
          <input type="checkbox" className="mt-1 shrink-0" checked={paths.includes(file.path)} onChange={event => {
            setPaths(event.target.checked ? [...paths, file.path] : paths.filter(path => path !== file.path)); change();
          }}/><span className="min-w-0 break-all">{file.path}</span>
        </label>)}
        <p className="text-muted">所选文件在投稿包中的路径以 extras/ 开头。</p>
      </fieldset>}
      <button type="button" className={`${formPrimaryButtonClass} self-start`} disabled={!matchesMode || profile.data === null || record.sourceHash === null || receipt !== null}
        data-testid="artifact-submission-prepare" onClick={() => {
          if (busy.current || profile.data === null || record.sourceHash === null) return;
          const parsed = researchSubmissionPrepareSchema.safeParse({projectId, exportId, expectedSourceHash: record.sourceHash,
            profile: {versionId: profile.data.snapshot.id, expectedHash: profile.data.snapshotHash}, requestId: requestId.current,
            mode, title, replacements: mode === 'named' ? [] : privateTerms.split('\n').map(value => value.trim()).filter(Boolean).map(find => ({find, replace: 'Anonymous'})),
            supplementPaths: paths});
          if (!parsed.success) {setValidation('请检查配置、标题和身份词；身份词至少两个字符且不能重复。'); return;}
          busy.current = true; onPending(true);
          void prepare.run(parsed.data).then(result => {busy.current = false; onPending(false); if (result.ok) {
            setReceipt(result.data); setPrivateTerms(''); onDirty(false); if (offset !== null) history.reload();
          }});
        }}>{active ? '正在编译投稿包…' : '生成并预检投稿包'}</button>
    </fieldset>
    {[profiles.error, profile.error, prepare.error, history.error, get.error, validation].filter(error => error !== null)
      .map((error, index) => <p key={index} role="alert" className="break-words text-[var(--st-warn)]">{error}</p>)}
    {current === null ? null : <SubmissionReceipt key={current.recordHash} client={client} receipt={current} writable={writable} onDirty={onDirty} onPending={onPending}/>}
    <button type="button" className={`${button} self-start`} disabled={active} onClick={() => guard.request(() => {
      if (offset === 0) history.reload(); else setOffset(0);
    })}>读取已生成投稿包</button>
    {history.status !== 'ready' || history.data === null || offset === null ? null : <>
      <ul className="flex min-w-0 flex-col gap-2">{history.data.items.filter(item => item.record.exportId === exportId).map(item => <li key={item.record.id}>
        <button type="button" className={`${button} max-w-full break-all text-left`} disabled={active} onClick={() => guard.request(() => {
          setPrivateTerms(''); setReceipt(null); setSelectionId(item.record.id); onDirty(false);
        })}>{item.record.mode === 'anonymous' ? '匿名版' : '署名版'}，{statusLabels[item.record.status]}，{item.record.createdAt}</button>
      </li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={active || offset === 0} onClick={() => setOffset(offset - 10)}>上一页投稿包</button>
        <button type="button" className={button} disabled={active || offset + 10 >= history.data.total} onClick={() => setOffset(offset + 10)}>下一页投稿包</button>
      </div>
    </>}
  </section>;
}

function SubmissionReceipt({client, receipt, writable, onDirty, onPending}: Callbacks & {
  client: RocClient; receipt: ResearchSubmissionReceipt; writable: boolean;
}): React.JSX.Element {
  const {record, recordHash} = receipt;
  const [note, setNote] = useState(''), [delivered, setDelivered] = useState<string | null>(null);
  const busy = useRef(false);
  const deliver = useAsyncAction(() => client.api.research.deliverSubmission({projectId: record.projectId, submissionId: record.id,
    expectedHash: recordHash, manualReviewNote: note.trim() === '' ? null : note.trim()}), {label: '另存投稿包'});
  const failed = record.preflight?.status === 'fail' || record.journalChecks.some(check => check.status === 'fail');
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-submission-receipt">
    <h3 className="font-medium">{record.mode === 'anonymous' ? '匿名投稿包' : '署名投稿包'}，{statusLabels[record.status]}</h3>
    {record.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{record.error}</p>}
    {record.preflight === null ? null : <>
      <p className="text-muted tabular-nums">实际编译 PDF：{record.preflight.pdf.pages} 页</p>
      <ul className="flex min-w-0 flex-col gap-2">{record.preflight.checks.map(check => <li key={check.kind} className="break-words">
        {kindLabels[check.kind]}：{checkLabels[check.status]}。{check.detail}
      </li>)}</ul>
    </>}
    {record.journalChecks.length === 0 ? null : <details className="min-w-0"><summary className="cursor-pointer text-muted">期刊规则预检</summary>
      <ul className="mt-2 space-y-1">{record.journalChecks.map(check => <li className="break-all" key={check.ruleId}>{check.ruleId}：{checkLabels[check.status]}</li>)}</ul>
    </details>}
    <details className="min-w-0"><summary className="cursor-pointer text-muted">文件与版本</summary>
      <p className="my-2 break-all font-mono text-muted">{record.id}，{recordHash}</p>
      <ul className="space-y-1">{record.files.map(file => <li className="break-all" key={file.path}>{file.path}，{file.size.toLocaleString()} B</li>)}</ul>
    </details>
    {record.manualReviewRequired ? <><label className="flex flex-col gap-1 text-muted">人工投稿核对说明
      <textarea className={`${formInputClass} h-auto resize-y py-2`} rows={3} maxLength={4000} value={note} disabled={!writable || deliver.pending}
        onChange={event => {setNote(event.target.value); onDirty(event.target.value !== ''); deliver.reset();}}/>
    </label><p className="text-muted">请核对图像、附加文件和预检中标记的人工项目。</p></> : null}
    <button type="button" className={`${formPrimaryButtonClass} self-start`} disabled={!writable || deliver.pending || record.status !== 'ready' ||
      failed || (record.manualReviewRequired && note.trim() === '')} data-testid="artifact-submission-deliver" onClick={() => {
      if (busy.current) return;
      busy.current = true; onPending(true);
      void deliver.run().then(result => {busy.current = false; onPending(false); if (result.ok && result.data !== null) {
        setDelivered(result.data.destinationPath); onDirty(false);
      }});
    }}>{deliver.pending ? '正在保存…' : '另存投稿包'}</button>
    {deliver.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{deliver.error}</p>}
    {delivered === null ? null : <p role="status" className="break-all text-muted">已保存到 {delivered}</p>}
  </section>;
}
