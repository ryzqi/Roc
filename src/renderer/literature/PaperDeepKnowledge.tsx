import {useEffect, useRef, useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import type {PaperDeepKnowledge as DeepKnowledge, PaperDeepSelection} from '../../shared/schemas/research-paper-deep-knowledge';
import type {PaperCardKnowledge} from '../../shared/schemas/research-paper-card-knowledge';
import type {ScientificSource} from '../../shared/schemas/research-scientific-facts';
import type {WikiPaperKnowledgeSource} from '../../shared/schemas/research-wiki-pages';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {ActionButton, formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {useVisiblePolling} from '../shared/view-activity';
import {ErrorBar} from '../shell/ErrorBar';
import {ScientificDocumentSource} from './ScientificDocumentSource';

type Props = {client: RocClient; projectId: string; documentId: string; objectId?: string};
const dimensionLabels: Record<PaperDeepSelection['dimensions'][number], string> = {
  research_problem: '研究问题', core_contribution: '核心贡献', method: '方法', mathematical_formulation: '数学表述',
  algorithm: '算法', experiments: '实验', results: '结果', ablation: '消融', limitations: '局限',
  open_questions: '开放问题', reproducibility: '可复现性'
};
const provenanceLabels = {author_stated: '作者陈述', source_derived: '原文整理', model_inference: '模型推断', unknown: '未知'};
const aspectLabels: Record<DeepKnowledge['claims'][number]['aspect'], string> = {
  summary: '概述', variables: '变量', units: '单位', inputs: '输入', outputs: '输出', assumptions: '前置假设',
  referenced_definitions: '引用定义', referenced_equations: '引用公式', derivation_steps: '推导步骤', complexity: '复杂度',
  dataset: '数据集', dataset_version: '数据集版本', split: '划分', metric: '指标', metric_definition: '指标定义',
  baseline: '基线', raw_result: '原始结果', hardware: '硬件', training_budget: '训练预算', inference_budget: '推理预算',
  random_seeds: '随机种子', repeats: '实验次数', uncertainty: '不确定度', caption: '图注', body_references: '正文引用',
  steps: '算法步骤', code: '代码', parameters: '参数'
};
const relationshipLabels = {contains_component: '包含组件', uses_formula: '使用公式', tests_component: '测试组件', ablates_component: '移除组件'};
const jobLabels = {queued: '深读已排队', running: '正在生成深读', published: '深读已生成', failed: '深读失败', cancelled: '深读已取消'};
const allDimensions = Object.keys(dimensionLabels) as PaperDeepSelection['dimensions'];
function objectDimensions(card: PaperCardKnowledge | null, objectId: string): PaperDeepSelection['dimensions'] {
  if (card?.objects?.equations.some(object => object.id === objectId)) return ['mathematical_formulation'];
  if (card?.objects?.tables.some(object => object.id === objectId)) return ['experiments', 'results', 'ablation'];
  if (card?.objects?.algorithms.some(object => object.id === objectId)) return ['method', 'algorithm'];
  if (card?.objects?.figures.some(object => object.id === objectId)) return ['method', 'results'];
  return allDimensions;
}

/** Opening this panel only reads state. Model work starts from an explicit user action. */
export function PaperDeepKnowledge(props: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <section className="min-w-0 space-y-3" data-testid="reading-deep-knowledge">
    <button type="button" className={formSecondaryButtonClass} aria-expanded={open}
      onClick={() => setOpen(value => !value)}>{props.objectId ? '深入阅读此对象' : '深度阅读'}</button>
    {open ? <DeepReadingPanel key={JSON.stringify([props.projectId, props.documentId, props.objectId])} {...props}/> : null}
  </section>;
}
export default PaperDeepKnowledge;

function DeepReadingPanel({client, projectId, documentId, objectId}: Props): React.JSX.Element {
  const [question, setQuestion] = useState(objectId ? '解释此对象的内容、前提与原始依据。' : '梳理论文的研究问题、方法、实验及可复现性。');
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const read = useAsyncResource(JSON.stringify([projectId, documentId]), () =>
    client.api.research.readPaperDeepKnowledge({projectId, documentId, generationId: null}), {label: '读取深度知识'});
  const request = useAsyncAction(() => client.api.research.requestPaperDeepKnowledge({projectId, documentId,
    purpose: 'reading', question: question.trim(), dimensions: objectId ? objectDimensions(read.data, objectId) : allDimensions, sectionIds: [], objectIds: objectId ? [objectId] : []}),
  {label: '生成深度知识'});
  const cancel = useAsyncAction((generationId: string) => client.api.research.cancelScientificExtraction({projectId, documentId, generationId}),
    {label: '取消深读'});
  const retry = useAsyncAction((generationId: string) => client.api.research.retryScientificExtraction({projectId, documentId, generationId}),
    {label: '重试深读'});
  const card = read.data, job = card?.latestJob, deepJob = job?.snapshot.deepRequest ? job : null;
  const running = job?.status === 'queued' || job?.status === 'running';
  const busy = request.pending || cancel.pending || retry.pending;
  useVisiblePolling(read.reload, 1500, running && !busy);
  const perform = async (operation: () => Promise<{ok: boolean}>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    try {await operation(); if (mounted.current) read.reload();} finally {lock.current = false;}
  };
  const deep = card?.knowledge?.deepReading;
  const matches = deep !== undefined && (objectId === undefined || deep.request.objectIds.includes(objectId) ||
    Object.values(deep.objects).some(objects => objects.some(object => object.id === objectId)));
  const current = card?.state === 'current' && deep?.status === 'source_validated';
  const reference = card?.publishedJob ? {documentId, generationId: card.publishedJob.id} : null;
  const error = read.error ?? request.error ?? cancel.error ?? retry.error;
  return <div className="min-w-0 space-y-3 border-t-[0.5px] border-line pt-3" data-testid="reading-deep-panel" aria-busy={busy}>
    <div className="flex flex-wrap items-center gap-3"><h3 className="font-medium">{objectId ? '对象深读' : '论文深读'}</h3>
      <span className="text-xs text-muted">未经科学审核</span></div>
    <label className="block space-y-1 text-xs">阅读问题
      <input className={formInputClass} value={question} maxLength={4000} disabled={busy || running}
        onChange={event => setQuestion(event.target.value)}/></label>
    <div className="flex flex-wrap gap-2">
      <ActionButton variant="compact" loading={request.pending} loadingLabel="正在提交…"
        disabled={busy || running || !question.trim() || read.status !== 'ready'}
        onClick={() => {void perform(request.run);}}>生成深读</ActionButton>
      <ActionButton variant="compact" loading={read.status === 'loading'} loadingLabel="正在刷新…" disabled={busy}
        onClick={read.reload}>刷新深读</ActionButton>
      {deepJob && running ? <ActionButton variant="compact" loading={cancel.pending} loadingLabel="正在取消…" disabled={busy}
        onClick={() => {void perform(() => cancel.run(deepJob.id));}}>取消深读</ActionButton> : null}
      {deepJob && (deepJob.status === 'failed' || deepJob.status === 'cancelled') ?
        <ActionButton variant="compact" loading={retry.pending} loadingLabel="正在重试…" disabled={busy}
          onClick={() => {void perform(() => retry.run(deepJob.id));}}>重试深读</ActionButton> : null}
    </div>
    {error ? <ErrorBar error={{level: 'blocked', message: error, retry: read.reload}}/> : null}
    {card?.configurationError ? <p role="alert" className="text-xs">{card.configurationError}</p> : null}
    {deepJob ? <p role={deepJob.status === 'failed' ? 'alert' : 'status'} className="text-xs text-muted">
      {jobLabels[deepJob.status]}{deepJob.error ? `：${deepJob.error}` : ''}</p> : running ? <p role="status" className="text-xs text-muted">基础知识正在生成</p> : null}
    {read.status === 'loading' && !card ? <p role="status" className="text-xs text-muted">读取深读状态…</p> : null}
    {!matches && card ? <p className="text-xs text-muted">尚无此范围的深读结果。</p> : null}
    {matches && deep && reference ? <>
      <p className="text-xs text-muted" data-testid="reading-deep-source-status">{current ? '原始来源已校验' : '来源或模型已变化，此结果已过期'}</p>
      <p className="break-words text-xs">阅读问题：{deep.request.question}</p>
      <p className="text-xs text-muted">深读范围：{deep.request.objectIds.length ? `${deep.request.objectIds.length} 个指定对象` :
        deep.request.sectionIds.length ? `${deep.request.sectionIds.length} 个指定章节` : '全篇'}</p>
      {deep.request.dimensions.map(dimension => <DeepDimension key={`${reference.generationId}:${dimension}`} dimension={dimension}
        claims={deep.claims.filter(claim => claim.dimension === dimension &&
          (objectId === undefined || claim.objectId === null || claim.objectId === objectId))}
        client={client} projectId={projectId} reference={reference} current={current}/>)}
      {deep.relationships.length ? <details><summary className="cursor-pointer text-xs">方法与算法关系（{deep.relationships.length} 条）</summary>
        <ul className="space-y-3 py-2">{deep.relationships.map(relation => <li key={relation.id} className="space-y-1 text-xs">
          <p>{relationshipLabels[relation.type]}，{provenanceLabels[relation.provenance]}</p>
          <p className="whitespace-pre-wrap break-words">{relation.from.quote} → {relation.to.quote}</p>
          <DeepSources sources={relation.evidence} client={client} projectId={projectId} reference={reference} current={current}/>
        </li>)}</ul>
      </details> : null}
    </> : null}
  </div>;
}
function DeepDimension({dimension, claims, client, projectId, reference, current}: {
  dimension: PaperDeepSelection['dimensions'][number]; claims: DeepKnowledge['claims'];
  client: RocClient; projectId: string; reference: WikiPaperKnowledgeSource; current: boolean
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const ordered = [...claims.filter(claim => claim.provenance !== 'unknown'), ...claims.filter(claim => claim.provenance === 'unknown')];
  return <details open={claims.some(claim => claim.provenance !== 'unknown')} data-testid="reading-deep-dimension">
    <summary className="cursor-pointer text-xs font-medium">{dimensionLabels[dimension]}</summary>
    <ul className="space-y-3 py-2">{ordered.slice(offset, offset + 20).map(claim => <li key={claim.id} className="space-y-1">
      <p className="flex flex-wrap gap-x-3 text-xs text-muted"><span>{aspectLabels[claim.aspect]}</span>
        <span>{provenanceLabels[claim.provenance]}</span></p>
      <p className="whitespace-pre-wrap break-words text-[length:var(--font-body-size)]">{claim.provenance === 'unknown' ? '未知：原文依据不足' : claim.text}</p>
      {claim.evidence.length ? <DeepSources sources={claim.evidence} client={client} projectId={projectId}
        reference={reference} current={current}/> : null}
    </li>)}</ul>
    {claims.length > 20 ? <nav className="flex flex-wrap gap-2" aria-label={`${dimensionLabels[dimension]}分页`}>
      <button type="button" className={formSecondaryButtonClass} disabled={offset === 0}
        onClick={() => setOffset(value => Math.max(0, value - 20))}>前 20 条</button>
      <button type="button" className={formSecondaryButtonClass} disabled={offset + 20 >= claims.length}
        onClick={() => setOffset(value => value + 20)}>后 20 条</button>
    </nav> : null}
  </details>;
}
function DeepSources({sources, client, projectId, reference, current}: {
  sources: ScientificSource[]; client: RocClient; projectId: string; reference: WikiPaperKnowledgeSource; current: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState<number | null>(null);
  return <div className="space-y-2">{sources.map((source, index) => <div key={index} className="space-y-1">
    <button type="button" className={formSecondaryButtonClass} disabled={!current} aria-expanded={open === index}
      onClick={() => setOpen(value => value === index ? null : index)}>原文依据 {index + 1}{source.locator?.locations[0] ? `，第 ${source.locator.locations[0].page} 页` : ''}</button>
    {open === index ? <ScientificDocumentSource client={client} projectId={projectId} reference={reference} source={source}/> : null}
  </div>)}</div>;
}
