import {useRef, useState} from 'react';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {useWorkspaceScope} from '../app/workspace-scope';
import {ArtifactEditorBoundary, useArtifactEditorGuard, useArtifactEditorStatus} from '../artifacts/artifact-editor-guard';
import {ModalShell} from '../shell/ModalShell';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {researchManuscriptSyncAttachSchema, type ResearchManuscriptSyncApply,
  type ResearchManuscriptSyncAttach, type ResearchManuscriptSyncInspection} from '../../shared/schemas/research-manuscript-sync';
import type {ResearchEvidence} from '../../shared/types';

const statuses = {unbound: '尚未绑定', current: '与保存稿件一致', changed: '有未同步修改', conflict: '需要处理冲突'};
const button = formSecondaryButtonClass;
type Change = ResearchManuscriptSyncInspection['changes'][number];
type PanelProps = {projectId: string; open: boolean; onClose: () => void};

export function ManuscriptSyncPanel(props: PanelProps): React.JSX.Element {
  return <ArtifactEditorBoundary projectId={props.projectId}><SyncDialog {...props}/></ArtifactEditorBoundary>;
}

function SyncDialog({projectId, open, onClose}: PanelProps): React.JSX.Element {
  const guard = useArtifactEditorGuard();
  return <ModalShell title="稿件同步" open={open} testId="writing-sync" widthClassName="w-[840px]"
    returnFocusSelector='[data-testid="writing-manuscript-sync"]' closeDisabled={guard.busy()}
    onClose={() => guard.request(onClose, '关闭将放弃选中的稿件修改和证据。')}>
    <SyncForm projectId={projectId}/>
  </ModalShell>;
}

function SyncForm({projectId}: {projectId: string}): React.JSX.Element {
  const {client, writable, openArtifact, openFileInCanvas} = useWorkspaceScope();
  const guard = useArtifactEditorGuard();
  const [selection, setSelection] = useState<string | null>(null);
  const [reply, setReply] = useState<ResearchManuscriptSyncInspection | null>(null);
  const [paths, setPaths] = useState({texPath: '', bibPath: ''});
  const [validation, setValidation] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [saved, setSaved] = useState(false);
  const request = useRef<{signature: string; id: string} | null>(null);
  const busy = useRef(false);
  const manuscripts = useAsyncResource(`manuscript-sync:list:${projectId}`, async () => {
    const result = await client.api.research.listArtifacts({projectId});
    return result.ok ? {ok: true as const, data: result.data.filter(artifact => artifact.kind === 'manuscript' && artifact.status !== 'superseded')} : result;
  }, {label: '读取正文工件'});
  const artifactId = selection ?? manuscripts.data?.[0]?.id ?? null;
  const read = useAsyncResource(artifactId === null || reply !== null ? null : `manuscript-sync:preview:${projectId}:${artifactId}`,
    () => client.api.research.inspectManuscriptSync({projectId, artifactId: artifactId!}), {label: '比较稿件'});
  const inspection = reply ?? (read.status === 'ready' ? read.data : null);
  const changes = inspection?.changes ?? [];
  const selected = changes.filter(change => Object.hasOwn(choices, change.id));
  const needsEvidence = selected.some(change => change.kind === 'claim' && choices[change.id]!.length === 0);
  const evidence = useAsyncResource(selected.some(change => change.kind === 'claim') ? `manuscript-sync:evidence:${projectId}` : null,
    () => client.api.research.listEvidence({projectId}), {label: '读取项目证据'});
  const attach = useAsyncAction((input: ResearchManuscriptSyncAttach) => client.api.research.attachManuscriptSync(input), {label: '绑定稿件'});
  const apply = useAsyncAction((input: ResearchManuscriptSyncApply) => client.api.research.applyManuscriptSync(input), {label: '采纳修改'});
  useArtifactEditorStatus({label: '稿件同步', dirty: selected.length > 0 || paths.texPath !== '' || paths.bibPath !== '', pending: () => busy.current});
  const pending = attach.pending || apply.pending;
  const reset = (): void => {
    setChoices({}); setPaths({texPath: '', bibPath: ''}); setSaved(false); setValidation(null); setReply(null);
    attach.reset(); apply.reset(); request.current = null;
  };
  const finish = (result: ResearchManuscriptSyncInspection): void => {
    reset(); setSelection(result.artifactId); setReply(result);
    if (result.artifactId !== artifactId) manuscripts.reload();
  };
  const bind = async (mode: ResearchManuscriptSyncAttach['mode']): Promise<void> => {
    if (!writable || busy.current || inspection === null) return;
    const input = researchManuscriptSyncAttachSchema.safeParse({projectId, artifactId, expectedArtifactVersion: inspection.artifactVersion,
      texPath: paths.texPath.trim(), bibPath: paths.bibPath.trim(), mode});
    if (!input.success) {setValidation('请输入工作区内的 .tex 和 .bib 相对路径。'); return;}
    busy.current = true; setValidation(null);
    const result = await attach.run(input.data);
    busy.current = false;
    if (result.ok) finish(result.data);
  };
  const accept = async (): Promise<void> => {
    if (!writable || busy.current || !inspection?.canApply || artifactId === null || selected.length === 0 || needsEvidence) return;
    const input = {projectId, artifactId, expectedPreviewHash: inspection.previewHash,
      changes: selected.map(change => ({id: change.id, evidenceIds: choices[change.id]!}))};
    const signature = JSON.stringify(input);
    if (request.current?.signature !== signature) request.current = {signature, id: crypto.randomUUID()};
    busy.current = true;
    const result = await apply.run({...input, requestId: request.current.id});
    busy.current = false;
    if (result.ok) {finish(result.data); setSaved(true);}
  };
  return <div className="flex min-w-0 flex-col gap-4" aria-busy={pending}>
    <label className="flex min-w-0 flex-col gap-1 text-muted">正文工件
      <select className={formInputClass} value={artifactId ?? ''} disabled={pending || manuscripts.data === null}
        onChange={event => {const id = event.target.value; guard.request(() => {reset(); setSelection(id);}, '切换稿件将放弃当前选择。');}}>
        {artifactId === null ? <option value="">{manuscripts.error !== null ? '读取失败' :
          manuscripts.data === null ? '正在读取正文工件…' : '尚无正文工件'}</option> : null}
        {manuscripts.data?.map(artifact => <option key={artifact.id} value={artifact.id}>
          {artifact.title}{artifact.status === 'approved' ? '（已批准）' : '（草稿）'}
        </option>)}
        {artifactId !== null && !manuscripts.data?.some(item => item.id === artifactId) ? <option value={artifactId}>已同步的新稿件</option> : null}
      </select>
    </label>
    {manuscripts.error === null ? null : <button type="button" className={`${button} self-start`} onClick={manuscripts.reload}>重新读取正文工件</button>}
    {artifactId === null ? null : <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted">比较工作区中已保存的文件。</span>
      <button type="button" className={button} disabled={pending || read.status === 'loading'}
        data-testid="writing-sync-refresh" onClick={() => guard.request(() => {reset(); read.reload();}, '重新比较将放弃当前选择。')}>
        重新比较
      </button>
    </div>}
    {inspection === null ? read.status === 'loading' && <p role="status">正在读取稿件…</p> : <>
      <p role="status">{pending ? '正在保存…' : statuses[inspection.status]}</p>
      {inspection.binding === null ? <fieldset disabled={!writable || pending} className="grid min-w-0 gap-3">
        {(['texPath', 'bibPath'] as const).map(name => (
          <label key={name} className="flex min-w-0 flex-col gap-1 text-muted">{name === 'texPath' ? 'LaTeX 路径' : 'BibTeX 路径'}
            <input className={formInputClass} value={paths[name]} onChange={event => setPaths({...paths, [name]: event.target.value})}/>
          </label>
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => void bind('checkout')}>生成工作稿</button>
          <button type="button" className={button} onClick={() => void bind('existing')}>绑定已有文件</button>
        </div>
      </fieldset> : <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
        {Object.entries(inspection.binding).map(([kind, relativePath]) => <div key={kind} className="contents">
          <dt>{kind === 'texPath' ? 'LaTeX' : 'BibTeX'}</dt>
          <dd className="min-w-0"><button type="button" className={`${button} max-w-full break-all text-left`} disabled={pending}
            onClick={() => guard.request(() => {setChoices({}); openFileInCanvas(relativePath);}, '打开文件将放弃当前选择。')}>
            {relativePath}
          </button></dd>
        </div>)}
      </dl>}
      {inspection.issues.length === 0 ? null : <ul className="flex flex-col gap-1 text-[var(--st-warn)]">
        {inspection.issues.map(issue => <li key={issue} className="break-words">{issue}</li>)}
      </ul>}
      {changes.length === 0 ? null : <div className="flex min-w-0 flex-col gap-3">
        {inspection.canApply ? null : <p className="text-muted">请在当前稿件的编辑或修订阶段采纳修改。</p>}
        <fieldset disabled={!writable || pending} className="min-w-0 space-y-3">
          {changes.map(change => <ChangeRow key={change.id} change={change} chosen={choices[change.id]}
            evidence={evidence.data ?? []} canChoose={inspection.canApply} onChoose={ids => setChoices(previous => {
              const next = {...previous};
              if (ids === undefined) delete next[change.id]; else next[change.id] = ids;
              return next;
            })}/>)}
        </fieldset>
        {needsEvidence ? <p className="text-muted">为选中的正文修改添加证据。</p> : null}
        <button type="button" className={`${formPrimaryButtonClass} self-start`}
          disabled={!writable || pending || !inspection.canApply || selected.length === 0 || needsEvidence}
          data-testid="writing-sync-apply" onClick={() => void accept()}>采纳 {selected.length} 项修改</button>
      </div>}
      {saved ? <div className="flex flex-wrap items-center gap-2">
        <p role="status">已保存稿件修订</p>
        <button type="button" className={button} onClick={() => openArtifact({projectId, artifactId: inspection.artifactId,
          expectedVersion: inspection.artifactVersion}, () => undefined)}>核对正文工件</button>
      </div> : null}
    </>}
    {[manuscripts.error, read.error, evidence.error, validation, attach.error, apply.error].filter(message => message !== null)
      .map((message, index) => <p key={index} role="alert" className="break-words text-[var(--st-warn)]">{message}</p>)}
  </div>;
}

function ChangeRow({change, chosen, evidence, canChoose, onChoose}: {
  change: Change; chosen: string[] | undefined; evidence: ResearchEvidence[];
  canChoose: boolean; onChoose: (ids: string[] | undefined) => void;
}): React.JSX.Element {
  return <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-3">
    <label className="flex items-start gap-2 font-medium">
      <input type="checkbox" className="mt-1 shrink-0" checked={chosen !== undefined} disabled={!canChoose}
        onChange={event => onChoose(event.target.checked ? [...change.evidenceIds] : undefined)}/>
      <span className="min-w-0 break-words">{change.label}</span>
    </label>
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
      <dt className="text-muted">原文</dt><dd className="whitespace-pre-wrap break-words">{change.before || '无'}</dd>
      <dt className="text-muted">工作稿</dt><dd className="whitespace-pre-wrap break-words">{change.after || '无'}</dd>
      {change.citationKeys.length === 0 ? null : <><dt className="text-muted">引用键</dt><dd className="break-all">{change.citationKeys.join('、')}</dd></>}
    </dl>
    {chosen === undefined || change.kind !== 'claim' ? null : <>
      {chosen.map(id => {
        const source = evidence.find(item => item.id === id);
        return <div key={id} className="flex min-w-0 items-start justify-between gap-2">
          <details className="min-w-0"><summary className="cursor-pointer break-words">{source?.title ?? id}</summary>
            <p className="text-muted">{source?.locator}</p><p className="whitespace-pre-wrap break-words">{source?.excerpt}</p>
          </details>
          <button type="button" className={button} onClick={() => onChoose(chosen.filter(value => value !== id))}>移除证据</button>
        </div>;
      })}
      <label className="flex min-w-0 flex-col gap-1 text-muted">添加项目证据
        <select className={formInputClass} value="" disabled={chosen.length >= 100} onChange={event => {
          if (event.target.value) onChoose([...chosen, event.target.value]);
        }}>
          <option value="">选择证据</option>
          {evidence.filter(item => !chosen.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}，{item.locator}</option>)}
        </select>
      </label>
    </>}
  </section>;
}
