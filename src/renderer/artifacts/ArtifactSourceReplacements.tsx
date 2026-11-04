import {useEffect, useRef, useState} from 'react';
import type {ResearchInspectedEvidence} from '../../shared/schemas/research-evidence-source';
import type {ResearchSourceReplacementInspection, ResearchSourceReplacementRequest} from '../../shared/schemas/research-source-replacements';
import type {ResearchExperimentExecution} from '../../shared/schemas/research-experiments';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const input = `${formInputClass} min-w-0 border-[0.5px]`;

export function ArtifactSourceReplacements({client, source, canDecide, onChanged}: {
  client: RocClient; source: ResearchInspectedEvidence; canDecide: boolean; onChanged: () => void
}): React.JSX.Element {
  const {projectId, id: evidenceId} = source.evidence;
  const history = useAsyncResource(`source-replacements:${projectId}:${evidenceId}`,
    () => client.api.research.listSourceReplacements({projectId, evidenceId}), {label: '读取来源替代历史'});
  const choices = useAsyncResource(canDecide ? `source-replacement-choices:${projectId}:${evidenceId}` : null,
    () => client.api.research.listEvidence({projectId}), {label: '读取本项目证据'});
  const [targetId, setTargetId] = useState('');
  const [pending, setPending] = useState(false);
  return <section aria-label="来源替代" data-testid="artifact-source-replacements" className="mt-3 flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-medium">来源替代</h3>
      <button type="button" className={button} disabled={history.status === 'loading' || pending}
        data-testid="artifact-source-replacements-refresh" onClick={history.reload}>刷新历史</button>
    </div>
    <p className="text-muted">明确选择前后来源会撤销旧引用的有效审核。新证据仍需另行审核主张关系。</p>
    {history.status === 'loading' ? <p role="status">正在读取来源替代历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-error)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null ? null : history.data.length === 0 ?
      <p className="text-muted">没有保存的前后来源关联。</p> : history.data.map(inspection =>
        <ReplacementHistory key={inspection.replacement.id} inspection={inspection} evidenceId={evidenceId}/>)}
    {!canDecide ? <p className="text-muted">重新核对当前工件后再选择；归档项目只读。</p> : <>
      {choices.status === 'loading' ? <p role="status">正在读取本项目证据…</p> : null}
      {choices.error === null ? null : <p role="alert" className="text-[var(--st-error)]">{choices.error}
        <button type="button" className={`${button} ml-2`} onClick={choices.reload}>重试读取证据</button></p>}
      {choices.status !== 'ready' || choices.data === null ? null : <>
        <label className="flex min-w-0 flex-col gap-1 text-muted">选择新来源证据
          <select className={input} value={targetId} disabled={pending} data-testid="artifact-source-replacement-target"
            data-reading-key={`source-replacement-target:${evidenceId}`} onChange={event => setTargetId(event.target.value)}>
            <option value="">请选择证据</option>
            {choices.data.filter(evidence => evidence.id !== evidenceId).map(evidence =>
              <option key={evidence.id} value={evidence.id}>{evidence.title}，{evidence.locator}，{evidence.id}</option>)}
          </select>
        </label>
        <p className="text-muted">按捕获顺序从新到旧排列；同名或相似文本不代表替代关系。</p>
        {targetId === '' ? null : <ReplacementSelection key={targetId} client={client} projectId={projectId}
          evidenceId={evidenceId} targetId={targetId} onChanged={onChanged} onPending={setPending}/>}
      </>}
    </>}
  </section>;
}

function ReplacementSelection({client, projectId, evidenceId, targetId, onChanged, onPending}: {
  client: RocClient; projectId: string; evidenceId: string; targetId: string; onChanged: () => void; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const original = useAsyncResource(`replacement-original:${projectId}:${evidenceId}:${targetId}`,
    () => client.api.research.inspectEvidence({projectId, evidenceId}), {label: '核对旧来源'});
  const target = useAsyncResource(`replacement-target:${projectId}:${targetId}`,
    () => client.api.research.inspectEvidence({projectId, evidenceId: targetId}), {label: '核对新来源'});
  const source = original.status === 'ready' ? original.data?.source : undefined;
  const destination = target.status === 'ready' ? target.data?.source : undefined;
  const rerun = source?.evidence.sourceType === 'experiment' && destination?.evidence.sourceType === 'experiment';
  const previousRun = useAsyncResource(rerun ? `replacement-run:${projectId}:${source.evidence.sourceId}` : null,
    () => client.api.research.getExperiment({projectId, runId: source!.evidence.sourceId}), {label: '核对前序实验'});
  const currentRun = useAsyncResource(rerun ? `replacement-run:${projectId}:${destination.evidence.sourceId}` : null,
    () => client.api.research.getExperiment({projectId, runId: destination!.evidence.sourceId}), {label: '核对重跑实验'});
  const [note, setNote] = useState('');
  const requests = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const action = useAsyncAction((request: ResearchSourceReplacementRequest) => client.api.research.replaceEvidenceSource(request),
    {label: '保存来源替代'});
  const sourceDocumentId = source?.sourceLocator?.documentId;
  const sameDocument = sourceDocumentId !== undefined && sourceDocumentId === destination?.sourceLocator?.documentId;
  const documents = source?.sourceLocator != null && destination?.sourceLocator != null && !sameDocument;
  const completed = (run: ResearchExperimentExecution | null): boolean => run !== null && run.status === 'completed' &&
    run.environment !== null && run.inputHash !== null && run.exitCode === 0 && run.error === null;
  const validRerun = rerun && previousRun.status === 'ready' && currentRun.status === 'ready' &&
    completed(previousRun.data) && completed(currentRun.data) && source.evidence.sourceId !== destination.evidence.sourceId;
  const valid = original.status === 'ready' && target.status === 'ready' && destination?.referenceStatus === 'recorded' &&
    (documents || validRerun);
  const submit = async (): Promise<void> => {
    const fields = {projectId, evidenceId, targetEvidenceId: targetId,
      kind: rerun ? 'experiment_rerun' as const : 'document_replacement' as const,
      expectedSourceDigest: original.data!.sourceDigest, expectedTargetDigest: target.data!.sourceDigest,
      note: note.trim() === '' ? null : note.trim()};
    const key = JSON.stringify(fields);
    let requestId = requests.current.get(key);
    if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(key, requestId);}
    onPending(true);
    const result = await action.run({...fields, requestId});
    if (mounted.current) {
      onPending(false);
      if (result.ok) onChanged();
    }
  };
  return <div data-testid="artifact-source-replacement-selection" className="flex min-w-0 flex-col gap-2">
    <button type="button" className={`${button} self-start`} disabled={action.pending || original.status === 'loading' || target.status === 'loading'}
      data-testid="artifact-source-replacement-reread" onClick={() => {original.reload(); target.reload(); previousRun.reload(); currentRun.reload();}}>
      重新核对两端
    </button>
    {original.status === 'loading' || target.status === 'loading' || previousRun.status === 'loading' || currentRun.status === 'loading' ?
      <p role="status">正在核对来源版本与运行…</p> : null}
    {[original.error, target.error, previousRun.error, currentRun.error].filter(error => error !== null).map((error, index) =>
      <p key={index} role="alert" className="break-words text-[var(--st-error)]">{error}</p>)}
    {source === undefined ? null : <SelectedSource label="旧来源" source={source} digest={original.data!.sourceDigest}/>}
    {destination === undefined ? null : <SelectedSource label="新来源" source={destination} digest={target.data!.sourceDigest}/>}
    {destination?.referenceStatus === 'superseded' ? <p role="alert">新来源已失效，请选择当前有效证据。</p> : null}
    {sameDocument ? <p role="alert">同文档重解析请核对定位候选。</p> : null}
    {!rerun || previousRun.data === null || currentRun.data === null ? null :
      <RunFacts previous={previousRun.data} current={currentRun.data}/>}
    {rerun && previousRun.status === 'ready' && currentRun.status === 'ready' && !validRerun ?
      <p role="alert">前后来源必须来自两个不同的已完成实验。</p> : null}
    {source === undefined || destination === undefined || documents || rerun || sameDocument ? null :
      <p role="alert">需要两个托管文档，或两个已完成实验的证据。</p>}
    <label className="flex min-w-0 flex-col gap-1 text-muted">替代说明
      <textarea rows={2} maxLength={10000} className={input} value={note} disabled={action.pending}
        data-testid="artifact-source-replacement-note" data-reading-key={`source-replacement-note:${evidenceId}:${targetId}`}
        onChange={event => setNote(event.target.value)}/>
    </label>
    <button type="button" className={`${button} self-start`} disabled={!valid || action.pending}
      data-testid="artifact-source-replacement-save" onClick={() => {void submit();}}>
      {rerun ? '确认重跑前后关联' : '确认替代旧来源'}
    </button>
    {action.pending ? <p role="status">正在保存来源替代…</p> : null}
    {action.error === null ? null : <p role="alert" className="text-[var(--st-error)]">{action.error}</p>}
  </div>;
}

function SelectedSource({label, source, digest}: {
  label: string; source: ResearchInspectedEvidence; digest: string
}): React.JSX.Element {
  return <details open className="min-w-0 border-t-[0.5px] border-line py-2 [&::details-content]:overflow-clip!"
    data-reading-key={`replacement-source:${label}:${source.evidence.id}`}>
    <summary className="cursor-pointer break-words">{label}，{source.evidence.title}</summary>
    <div className="mt-2 flex min-w-0 flex-col gap-1">
      <p className="break-all text-muted">证据 {source.evidence.id}，{source.referenceStatus === 'recorded' ? '引用有效' : '引用已失效'}</p>
      <p className="break-words">{source.evidence.locator}</p>
      <blockquote className="whitespace-pre-wrap break-words">{source.evidence.excerpt}</blockquote>
      <p className="break-all text-muted">来源版本 {source.evidence.sourceVersion}</p>
      {source.sourceLocator === null ? null : <p className="break-all text-muted">
        文档 {source.sourceLocator.documentId}，解析 {source.sourceLocator.parseId}，原文 SHA-256 {source.sourceLocator.sourceHash}
      </p>}
      <p className="break-all font-mono text-[var(--font-meta-size)] text-muted">来源摘要 SHA-256 {digest}</p>
    </div>
  </details>;
}

function RunFacts({previous, current}: {previous: ResearchExperimentExecution; current: ResearchExperimentExecution}): React.JSX.Element {
  return <details data-testid="artifact-source-replacement-runs" className="min-w-0 [&::details-content]:overflow-clip!">
    <summary className="cursor-pointer">实验前后输入、环境与输出</summary>
    <p className="mt-2 text-muted">以下是保存的运行事实；输出变化与科学等价需另行判断。</p>
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      {[{label: '前序', execution: previous}, {label: '重跑', execution: current}].map(({label, execution}) => {
        return <div key={execution.id} className="min-w-0 border-t-[0.5px] border-line pt-2">
          <p className="break-all">{label} {execution.id}，状态 {execution.status}</p>
          <p className="break-all text-muted">输入 SHA-256 {execution.inputHash}</p>
          <p className="break-all text-muted">环境 SHA-256 {execution.environment?.hash}</p>
          <pre className="whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify({
            request: execution.request, environment: execution.environment, files: execution.files
          }, null, 2)}</pre>
        </div>;
      })}
    </div>
  </details>;
}

function ReplacementHistory({inspection, evidenceId}: {
  inspection: ResearchSourceReplacementInspection; evidenceId: string
}): React.JSX.Element {
  const {replacement, targetReferenceStatus} = inspection;
  return <details className="min-w-0 border-t-[0.5px] border-line py-2 [&::details-content]:overflow-clip!"
    data-testid={`artifact-source-replacement-history-${replacement.id}`} data-reading-key={`source-replacement-history:${replacement.id}`}>
    <summary className="cursor-pointer">{replacement.request.kind === 'document_replacement' ? '已记录文档替代' : '已记录实验重跑'}
      <span className="ml-2 text-muted">{replacement.source.evidence.id === evidenceId ? '此证据为前序来源' : '此证据为新来源'}</span>
    </summary>
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      <p className="break-words text-muted">用户 {replacement.actor.id}，选择时间 {replacement.createdAt}</p>
      {replacement.request.note === null ? null : <p className="whitespace-pre-wrap break-words">{replacement.request.note}</p>}
      <p>选择时需要科学审核。{targetReferenceStatus === 'recorded' ? '新来源当前引用有效。' : '新来源当前引用已失效。'}</p>
      <SelectedSource label="旧来源原快照" source={replacement.source} digest={replacement.sourceDigest}/>
      <SelectedSource label="新来源原快照" source={replacement.target} digest={replacement.targetDigest}/>
      {replacement.experimentLineage === null ? null :
        <RunFacts previous={replacement.experimentLineage.previous} current={replacement.experimentLineage.current}/>}
      <details>
        <summary className="cursor-pointer">固定替代记录与哈希</summary>
        <p className="mt-1 break-all font-mono text-[var(--font-meta-size)]">{inspection.replacementHash}</p>
        <pre className="whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(replacement, null, 2)}</pre>
      </details>
    </div>
  </details>;
}
