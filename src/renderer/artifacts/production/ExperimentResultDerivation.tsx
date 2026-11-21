import {useRef, useState} from 'react';
import type {ResearchExperimentResultGet, ResearchExperimentResultReceipt} from '../../../shared/schemas/research-experiment-results';
import type {ResearchResultDerivation, ResearchResultDerivationRequest} from '../../../shared/schemas/research-result-derivation';
import {useAsyncAction, useAsyncResource} from '../../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../../shared/form-ui';
import {useCopyFeedback} from '../../shared/hooks/use-copy-feedback';
import type {RocClient} from '../../shared/roc-client';
import {useArtifactEditorGuard, useArtifactEditorStatus} from '../artifact-editor-guard';

type Figure = ResearchResultDerivation['figures'][number];
const button = formSecondaryButtonClass;
const issueLabels = {location_changed: '正文位置已变化', definition_changed: '指标定义已变化',
  source_changed: '来源已变化', unrepresentable_value: '现有格式无法表示新值'};
const surfaceLabels = {abstract: '摘要', body: '正文', table: '表格', figure_caption: '图注'};

export function ExperimentResultDerivation({client, receipt, previous, writable}: {
  client: RocClient; receipt: ResearchExperimentResultReceipt; writable: boolean;
  previous?: Omit<ResearchExperimentResultGet, 'projectId'> | undefined;
}): React.JSX.Element {
  const {snapshot, snapshotHash} = receipt;
  const projectId = snapshot.request.projectId;
  const base = {projectId, resultId: snapshot.id, expectedHash: snapshotHash};
  const [metricIds, setMetricIds] = useState(snapshot.result.metrics.map(metric => metric.id));
  const [chooseManuscript, setChooseManuscript] = useState(false);
  const [artifactId, setArtifactId] = useState('');
  const [commentId, setCommentId] = useState('');
  const readList = useAsyncResource(chooseManuscript ? `result-derivation:manuscripts:${projectId}` : null,
    () => client.api.research.listArtifacts({projectId}), {label: '读取项目稿件'});
  const artifacts = readList.data?.filter(value => value.kind === 'manuscript' && value.status !== 'superseded') ?? [];
  const artifact = useAsyncResource(artifactId === '' ? null : `result-derivation:artifact:${projectId}:${artifactId}`,
    () => client.api.research.inspectArtifact({projectId, artifactId, expectedVersion: null}), {label: '读取稿件版本'});
  const manuscript = artifact.status === 'ready' && artifact.data?.status === 'current' ?
    {artifactId, expectedVersion: artifact.data.snapshot.version} : null;
  const responses = useAsyncResource(manuscript === null ? null : `result-derivation:responses:${projectId}:${manuscript.expectedVersion}`,
    () => client.api.research.inspectResponseMatrix({projectId, artifactId, expectedHash: null}), {label: '读取审稿意见'});
  const comments = responses.status === 'ready' && responses.data?.report.artifactVersion === manuscript?.expectedVersion ?
    responses.data?.report.review?.snapshot.request.rows ?? [] : [];
  const request: ResearchResultDerivationRequest = {...base, metricIds,
    ...(previous === undefined ? {} : {previous}), ...(manuscript === null ? {} : {manuscript}),
    ...(comments.some(row => row.commentId === commentId) ? {commentId} : {})};
  const read = useAsyncResource(metricIds.length === 0 || (artifactId !== '' && manuscript === null) ? null :
    `result-derivation:preview:${JSON.stringify(request)}`, () => client.api.research.previewResultDerivation(request), {label: '生成写作材料'});
  const guard = useArtifactEditorGuard();
  const preview = read.status === 'ready' ? read.data : null;

  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" aria-label="实验写作材料"
    data-testid="artifact-experiment-derivation">
    {previous === undefined ? null : <p className="break-all text-muted">对照回执 {previous.resultId}</p>}
    {snapshot.result.metrics.length < 2 ? null : <details open={metricIds.length === 0 ? true : undefined}>
      <summary className="cursor-pointer">选取指标</summary>
      <fieldset disabled={guard.busy()} className="mt-2 flex flex-col gap-2">
        {snapshot.request.definitions.map(definition => <label key={definition.id} className="flex items-start gap-2">
          <input type="checkbox" checked={metricIds.includes(definition.id)} onChange={event => {
            const checked = event.target.checked;
            setMetricIds(ids => checked ? [...ids, definition.id] : ids.filter(id => id !== definition.id));
          }}/>
          <span className="break-words">{definition.label}（{definition.unit}）</span>
        </label>)}
      </fieldset>
    </details>}
    <button type="button" className={`${button} self-start`} disabled={guard.busy()} aria-expanded={chooseManuscript}
      onClick={() => {setChooseManuscript(!chooseManuscript); if (chooseManuscript) {setArtifactId(''); setCommentId('');}}}>
      {chooseManuscript ? '收起稿件选择' : '核对正文与回复'}
    </button>
    {chooseManuscript ? <>
      <label className="flex min-w-0 flex-col gap-1 text-muted">关联稿件
        <select className={formInputClass} value={artifactId} disabled={guard.busy() || readList.status === 'loading'}
          onChange={event => {setArtifactId(event.target.value); setCommentId('');}}>
          <option value="">{readList.status === 'loading' ? '正在读取稿件…' : '选择已保存稿件'}</option>
          {artifacts.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
        </select>
      </label>
      {artifact.status === 'loading' || responses.status === 'loading' ? <p role="status">正在读取稿件与意见…</p> : null}
      {comments.length === 0 ? null : <label className="flex min-w-0 flex-col gap-1 text-muted">审稿意见
        <select className={formInputClass} value={commentId} disabled={guard.busy()} onChange={event => setCommentId(event.target.value)}>
          <option value="">不生成回复草稿</option>
          {comments.map(row => <option key={row.commentId} value={row.commentId}>{row.reviewer}：{row.comment.slice(0, 100)}</option>)}
        </select>
      </label>}
    </> : null}
    {metricIds.length === 0 ? <p role="status" className="text-muted">请选择至少一个指标。</p> : null}
    {read.status === 'loading' ? <p role="status">正在核对来源并生成材料…</p> : null}
    {[readList.error, artifact.error, responses.error, read.error].filter(error => error !== null).map((error, index) =>
      <p key={index} role="alert" className="break-words text-[var(--st-warn)]">{error}</p>)}
    {read.error === null ? null : <button type="button" className={`${button} self-start`} onClick={read.reload}>重新核对来源</button>}
    {preview === null ? null : <>
      <h3 className="font-medium">方法草稿</h3>
      <p className="whitespace-pre-wrap break-words" data-testid="artifact-experiment-methods">{preview.methods}</p>
      <div className="flex flex-wrap gap-2">
        <CopyMaterial label="复制方法" value={preview.methods}/>
        <CopyMaterial label="复制指标表" value={metricTable(preview)}/>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {preview.figures.map(figure => <FigureSource key={figure.sourceHash} client={client} base={base} figure={figure} writable={writable}/>)}
      </div>
      {preview.manuscript === null ? null : <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium">正文修改建议</h3>
        {preview.manuscript.changes.length === 0 ? <p className="text-muted">{preview.previous === null ?
          '从实验比较中指定对照回执，以定位正文中的旧指标。' : '未找到可更新的数值位置。'}</p> :
          <ul className="flex min-w-0 flex-col gap-2">{preview.manuscript.changes.map(change => <li
            key={`${change.binding.claimId}:${change.binding.start}:${change.binding.metricId}`} className="break-words">
            <p className="tabular-nums">{change.before} → {change.after} {change.binding.unit}</p>
            <p className="break-all text-muted">{surfaceLabels[change.binding.surface]}，主张 {change.binding.claimId}</p>
            {change.evidenceId === null ? <p className="text-muted">采纳前请捕获新版指标证据。</p> : null}
          </li>)}</ul>}
        {preview.manuscript.issues.map((issue, index) => <p key={index} className="break-words text-muted">
          {issueLabels[issue.reason]}：{issue.metricId}
        </p>)}
        {preview.manuscript.paragraphs.map(paragraph => <details key={paragraph.claimId} className="min-w-0">
          <summary className="cursor-pointer break-all">段落建议 {paragraph.claimId}</summary>
          <p className="my-2 whitespace-pre-wrap break-words">{paragraph.after}</p>
          {paragraph.replacement === null ? null : <CopyMaterial label="复制 LaTeX 段落" value={paragraph.replacement.latex}/>}
        </details>)}
        {preview.manuscript.bibliography === '' ? null : <CopyMaterial label="复制新增 BibTeX" value={preview.manuscript.bibliography}/>}
      </section>}
      {preview.responseDraft === null ? null : <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium">回复草稿</h3>
        <blockquote className="whitespace-pre-wrap break-words text-muted">{preview.responseDraft.row.comment}</blockquote>
        <p className="whitespace-pre-wrap break-words">{preview.responseDraft.row.response}</p>
        <CopyMaterial label="复制回复" value={preview.responseDraft.row.response}/>
      </section>}
    </>}
  </section>;
}

function FigureSource({client, base, figure, writable}: {client: RocClient; base: ResearchExperimentResultGet; figure: Figure; writable: boolean}): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null);
  const busy = useRef(false);
  const prepare = useAsyncAction(() => client.api.research.prepareResultFigureSource({...base, metricIds: figure.metricIds,
    sourceHash: figure.sourceHash}), {label: '生成绘图源'});
  const {locked, isLocked} = useArtifactEditorStatus({label: '绘图源', dirty: false, pending: () => busy.current});
  return <div className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 break-words">绘图源（{figure.unit}）</span>
      <button type="button" disabled={!writable || locked || prepare.pending} className={button}
        data-testid="artifact-experiment-figure-prepare" onClick={() => {
          if (busy.current || isLocked()) return;
          busy.current = true;
          void prepare.run().then(result => {busy.current = false; if (result.ok) setPath(result.data.sourcePath);});
        }}>{prepare.pending ? '正在生成…' : '生成绘图源文件'}</button>
    </div>
    {prepare.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{prepare.error}</p>}
    {path === null ? null : <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="break-all text-muted" data-testid="artifact-experiment-figure-source-path">{path}</code>
      <CopyMaterial label="复制路径" value={path}/>
    </div>}
  </div>;
}

function CopyMaterial({label, value}: {label: string; value: string}): React.JSX.Element {
  const copy = useCopyFeedback();
  return <>
    <button type="button" className={`${button} self-start`} onClick={() => copy.copy(value)}>{copy.copied ? '已复制' : label}</button>
    {copy.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{copy.error}</p>}
  </>;
}

function metricTable(preview: ResearchResultDerivation): string {
  const quote = (value: string | number): string => typeof value === 'number' ? String(value) : `"${value.replaceAll('"', '""')}"`;
  return [['指标', '数值', '单位', '样本量'], ...preview.rows.map(({metric, definition}) =>
    [definition.label, metric.value, metric.unit, metric.sampleSize])].map(row => row.map(quote).join('\t')).join('\n');
}
