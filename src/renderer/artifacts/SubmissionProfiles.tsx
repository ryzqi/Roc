import {useRef, useState} from 'react';
import type {ResearchJournalSelection} from '../../shared/schemas/research-journal-compliance';
import {researchSubmissionProfileSaveSchema, type ResearchSubmissionProfileSave,
  type ResearchSubmissionProfileReceipt} from '../../shared/schemas/research-submission-profile';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {useArtifactEditorGuard} from './artifact-editor-guard';
import {ResearchProposalPicker} from './ResearchProposalPicker';

const lines = (value: string): string[] => value.split('\n').map(line => line.trim()).filter(Boolean);
export function SubmissionProfiles({client, projectId, artifactId, artifactVersion, profile, writable, onFill, onDirty, onPending}: {
  client: RocClient; projectId: string; artifactId: string; artifactVersion: string; profile: ResearchJournalSelection['profile'] | null; writable: boolean;
  onFill: (receipt: ResearchSubmissionProfileReceipt) => void; onDirty: (dirty: boolean) => void; onPending: (pending: boolean) => void;
}): React.JSX.Element {
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<ResearchSubmissionProfileReceipt | null>(null);
  const [draft, setDraft] = useState({maximumPages: '', anonymous: false, declarations: '', minimumEditableTables: '0', supplementPaths: ''});
  const [validation, setValidation] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const guard = useArtifactEditorGuard();
  const busy = useRef(false), requestId = useRef(crypto.randomUUID());
  const list = useAsyncResource(`submission-profiles:${projectId}:${offset}`,
    () => client.api.research.listSubmissionProfiles({projectId, offset, limit: 10}), {label: '读取投稿配置'});
  const get = useAsyncAction((receipt: ResearchSubmissionProfileReceipt) => client.api.research.getSubmissionProfile({projectId,
    versionId: receipt.snapshot.id, expectedHash: receipt.snapshotHash}), {label: '核对投稿配置'});
  const save = useAsyncAction((input: ResearchSubmissionProfileSave) => client.api.research.saveSubmissionProfile(input), {label: '保存投稿配置'});
  const pending = get.pending || save.pending;
  const read = (receipt: ResearchSubmissionProfileReceipt): void => {
    if (busy.current) return;
    busy.current = true; onPending(true);
    void get.run(receipt).then(result => {busy.current = false; onPending(false); if (!result.ok) return;
      const requirements = result.data.snapshot.request.requirements;
      setSelected(result.data); setDraft({maximumPages: requirements.maximumPages?.toString() ?? '', anonymous: requirements.anonymous,
        declarations: requirements.requiredDeclarations.join('\n'), minimumEditableTables: requirements.minimumEditableTables.toString(),
        supplementPaths: requirements.supplementPaths.join('\n')}); setDirty(false); onDirty(false); setValidation(null); requestId.current = crypto.randomUUID();
    });
  };
  const change = (next: typeof draft): void => {setDraft(next); setDirty(true); onDirty(true); requestId.current = crypto.randomUUID(); setValidation(null); save.reset();};
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" aria-label="可复用投稿配置" data-testid="artifact-submission-profiles">
    {list.status === 'loading' ? <p role="status">正在读取投稿配置…</p> : null}
    <ul className="flex min-w-0 flex-col gap-2">{list.data?.items.map(receipt => <li key={receipt.snapshot.id}>
      <button type="button" className={`${formSecondaryButtonClass} max-w-full break-words text-left`} disabled={!writable || pending}
        onClick={() => guard.request(() => read(receipt), '切换将放弃投稿配置修改。')}>{receipt.snapshot.request.profile.journal}，{receipt.snapshot.request.profile.articleType}，版本 {receipt.snapshot.version}</button>
    </li>)}</ul>
    {list.data === null ? null : <div className="flex flex-wrap gap-2">
      <button type="button" className={formSecondaryButtonClass} disabled={offset === 0 || pending} onClick={() => setOffset(offset - 10)}>上一页配置</button>
      <button type="button" className={formSecondaryButtonClass} disabled={offset + 10 >= list.data.total || pending} onClick={() => setOffset(offset + 10)}>下一页配置</button>
    </div>}
    {selected === null ? null : <div className="flex min-w-0 flex-col gap-2">
      <p className="break-words text-muted">已选：{selected.snapshot.request.profile.journal}，规则 {selected.snapshot.request.profile.version}</p>
      <button type="button" className={`${formSecondaryButtonClass} self-start`} disabled={!writable || pending} onClick={() => guard.request(() => {
        onDirty(false); onFill(selected);
      }, '填入规则将放弃投稿配置修改。')}>填入期刊规则</button>
    </div>}
    {profile === null ? <p className="text-muted">保存当前期刊规则后，可将它们存为可复用投稿配置。</p> : <>
      <p className="break-words text-muted">使用当前已保存的 {profile.journal} 规则。</p>
      <ResearchProposalPicker client={client} projectId={projectId} artifactId={artifactId} artifactVersion={artifactVersion}
        kind="submission_profile" disabled={!writable || dirty || pending}
        matches={proposal => proposal.kind === 'submission_profile' && JSON.stringify(proposal.payload.profile) === JSON.stringify(profile) &&
          (proposal.payload.parent === null || list.data?.items.some(item => item.snapshot.id === proposal.payload.parent?.versionId && item.snapshotHash === proposal.payload.parent.versionHash) === true)}
        onPick={proposal => {if (proposal.kind !== 'submission_profile') return;
          const {requirements, parent} = proposal.payload;
          setSelected(parent === null ? null : list.data?.items.find(item => item.snapshot.id === parent.versionId) ?? null);
          change({maximumPages: requirements.maximumPages?.toString() ?? '', anonymous: requirements.anonymous,
            declarations: requirements.requiredDeclarations.join('\n'), minimumEditableTables: requirements.minimumEditableTables.toString(),
            supplementPaths: requirements.supplementPaths.join('\n')});
        }}/>
      <fieldset disabled={!writable || pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex flex-col gap-1 text-muted">最多页数（留空不限制）
          <input className={formInputClass} type="number" min={1} max={5000} value={draft.maximumPages} onChange={event => change({...draft, maximumPages: event.target.value})}/>
        </label>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1 shrink-0" checked={draft.anonymous}
          onChange={event => change({...draft, anonymous: event.target.checked})}/><span>匿名审稿</span></label>
        <label className="flex flex-col gap-1 text-muted">必要声明（每行一项）
          <textarea className={`${formInputClass} h-auto resize-y py-2`} rows={3} value={draft.declarations} onChange={event => change({...draft, declarations: event.target.value})}/>
        </label>
        <label className="flex flex-col gap-1 text-muted">最少可编辑表格数
          <input className={formInputClass} type="number" min={0} max={1000} value={draft.minimumEditableTables} onChange={event => change({...draft, minimumEditableTables: event.target.value})}/>
        </label>
        <label className="flex flex-col gap-1 text-muted">必要补充文件（相对路径，每行一项）
          <textarea className={`${formInputClass} h-auto resize-y py-2`} rows={3} value={draft.supplementPaths} onChange={event => change({...draft, supplementPaths: event.target.value})}/>
        </label>
        <button type="button" className={`${formPrimaryButtonClass} self-start`} data-testid="artifact-submission-profile-save" onClick={() => {
          if (busy.current) return;
          const parsed = researchSubmissionProfileSaveSchema.safeParse({projectId, requestId: requestId.current,
            profileId: selected?.snapshot.profileId ?? null, parent: selected === null ? null : {versionId: selected.snapshot.id, versionHash: selected.snapshotHash},
            profile, requirements: {maximumPages: draft.maximumPages === '' ? null : Number(draft.maximumPages), anonymous: draft.anonymous,
              requiredDeclarations: lines(draft.declarations), minimumEditableTables: Number(draft.minimumEditableTables), supplementPaths: lines(draft.supplementPaths)}});
          if (!parsed.success) {setValidation('请检查页数、表格数量、声明和补充路径。'); return;}
          busy.current = true; onPending(true);
          void save.run(parsed.data).then(result => {busy.current = false; onPending(false); if (result.ok) {
            setSelected(result.data); setDirty(false); onDirty(false); requestId.current = crypto.randomUUID(); list.reload();
          }});
        }}>{pending ? '正在保存…' : selected === null ? '保存为投稿配置' : '保存配置新版本'}</button>
      </fieldset>
    </>}
    {[list.error, get.error, save.error, validation].filter(error => error !== null).map((error, index) => <p role="alert" key={index} className="break-words text-[var(--st-warn)]">{error}</p>)}
  </section>;
}
