import { useMemo, useState } from 'react';
import { Package, Send, XCircle } from 'lucide-react';
import type { ResearchExportDelivery, ResearchExportExecution, ResearchTemplate } from '../../shared/types';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { ProgressTask } from '../shell/ProgressTask';
import { formatBeijingDateTime, formatBytes } from '../shared/format';
import { useWorkflow } from '../canvas/workflow/workflow-scope';
import { exportApprovalLabel, exportFileKinds, exportReadiness, exportStatusLabel, exportTemplateSelection } from './production-rules';
import {
  cancelExport,
  getExportBundle,
  listExports,
  listFigures,
  listTemplates,
  prepareExport,
  publishExport,
  readExportFile,
  writeExport
} from './production-store';
import {
  FieldLabel,
  InlineHint,
  IssueList,
  KeyValue,
  PanelSection,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  textInputClass
} from './panel-shell';

/**
 * 导出包 (P7/T7.7).
 *
 * The step order is the contract's, not a form designer's:
 *
 *   1. **readiness** — `getExportBundle` is fetched first and `exportReadiness` blocks the prepare
 *      when a `supported` claim has no evidence (gate 6: 「没有证据的主张不能进入导出」). The block
 *      is shown *before* the user tries, and the backend would refuse it anyway
 *      (`research_claim_unverified`).
 *   2. **prepare** needs the manuscript artifact, the published figures and a template. An
 *      imported template must be `ready` (it carries revision + source digest for the
 *      optimistic-concurrency triple) — `exportTemplateSelection` returns null otherwise, and the
 *      panel then offers the default template with the reason.
 *   3. **publish** is the gate's action (the export stage's human gate), and `writeExport` is the
 *      delivery step. Delivery needs an **absolute `.zip` path** and there is no save dialog in
 *      the contract (B22), so this panel asks for one explicitly, marks it as a workaround, and
 *      refuses a non-`.zip` destination before the IPC round trip.
 */

export function ExportPanel({ writeAllowed }: { writeAllowed?: boolean }): React.JSX.Element {
  /**
   * Whether this panel may write.
   *
   * The stage workspace decides it (`scope.writable && stageGroupWriteAllowed(...)`) and passes it
   * down, because the *stage-group* half of the rule exists only in the renderer: the backend
   * refuses artifact writes for a non-current stage (`requireEditableStage`) but happily starts an
   * experiment run or a template compile, so a panel that gated on the archived flag alone would
   * offer live buttons behind a 「只读：非当前阶段组」 badge. `undefined` keeps the route-rendered
   * case (the `latex` view) working with the project-level predicate.
   */
  const scope = useWorkspaceScope();
  const canWrite = writeAllowed ?? scope.writable;
  const workflow = useWorkflow();
  const projectId = scope.projectId ?? '';
  const manuscriptArtifacts = useMemo(
    () => (workflow.artifacts ?? []).filter((artifact) => artifact.kind === 'manuscript'),
    [workflow.artifacts]
  );

  const [title, setTitle] = useState('导出包');
  const [manuscriptArtifactId, setManuscriptArtifactId] = useState('');
  const [figureIds, setFigureIds] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [selectedExportId, setSelectedExportId] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{ path: string; content: string; encoding: string } | null>(null);
  const [destinationPath, setDestinationPath] = useState('');
  const [deliveryAcknowledged, setDeliveryAcknowledged] = useState(false);
  /** `useAsyncAction` reports pending/error; the *result* of a delivery is kept here. */
  const [delivery, setDelivery] = useState<ResearchExportDelivery | null>(null);

  const exports = useAsyncResource<ResearchExportExecution[]>(
    scope.projectId === null ? null : `exports:${scope.projectId}`,
    () => listExports(scope.client, { projectId, limit: 50 }),
    { label: '读取导出包' }
  );
  const figures = useAsyncResource(
    scope.projectId === null ? null : `export-figures:${scope.projectId}`,
    () => listFigures(scope.client, { projectId, limit: 100 }),
    { label: '读取图稿' }
  );
  const templates = useAsyncResource<ResearchTemplate[]>(
    scope.projectId === null ? null : `export-templates:${scope.projectId}`,
    () => listTemplates(scope.client, projectId),
    { label: '读取模板' }
  );
  const bundle = useAsyncResource(
    manuscriptArtifactId.length === 0 ? null : `export-bundle:${manuscriptArtifactId}`,
    () => getExportBundle(scope.client, { projectId, artifactId: manuscriptArtifactId }),
    { label: '读取导出清单' }
  );

  const prepare = useAsyncAction(
    (input: {
      title: string;
      manuscriptArtifactId: string;
      figureIds: string[];
      template: { kind: 'default'; language: 'zh' | 'en' } | { kind: 'imported'; templateId: string; expectedRevision: number; expectedSourceDigest: string };
    }) =>
      prepareExport(scope.client, {
        projectId,
        requestId: `renderer_${crypto.randomUUID()}`,
        ...input
      }),
    { label: '准备导出包' }
  );
  const publish = useAsyncAction(
    (exportId: string) => publishExport(scope.client, { projectId, exportId, replacesExportId: null }),
    { label: '发布导出包' }
  );
  const cancel = useAsyncAction((exportId: string) => cancelExport(scope.client, { projectId, exportId }), {
    label: '取消导出包'
  });
  const deliver = useAsyncAction(
    (exportId: string) => writeExport(scope.client, { projectId, exportId, destinationPath: destinationPath.trim() }),
    { label: '交付导出包' }
  );

  const selected = (exports.data ?? []).find((entry) => entry.id === selectedExportId) ?? null;
  const selectedTemplate = (templates.data ?? []).find((template) => template.id === templateId) ?? null;
  const templateSelection = exportTemplateSelection(selectedTemplate);
  const readiness = exportReadiness(bundle.data ?? null);
  const bundleIssues = bundle.status === 'ready' && bundle.data === null
    ? [{ message: '还没有稿件：先生成并保存正文', reference: 'manuscript' }]
    : readiness.issues;

  const blockers = [
    ...(title.trim().length === 0 ? [{ message: '导出包标题不能为空', reference: 'title' }] : []),
    ...(manuscriptArtifactId.length === 0 ? [{ message: '选择一个正文工件', reference: 'manuscriptArtifactId' }] : []),
    // 表单与请求必须一致：选了一个还不能用的导入模板时**阻断**，而不是悄悄换成默认模板（评审 P2）。
    ...(templateId.length > 0 && templateSelection === null
      ? [{ message: `模板 ${templateId} 还不能用于导出（需先编译成功，携带 revision + sourceDigest）`, reference: 'template' }]
      : []),
    ...bundleIssues
  ];

  const activeExport = (exports.data ?? []).find((entry) => entry.status === 'preparing') ?? null;
  const fileGroups = exportFileKinds(selected?.files ?? []);

  if (scope.projectId === null) {
    return <InlineHint text="未进入项目。" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="production-export">
      <PanelSection title="准备导出包" hint="research.export.prepare（正文 + 图稿 + 模板）" testId="production-export-prepare">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[200px] flex-1 flex-col gap-0.5">
            <FieldLabel text="标题" />
            <input data-testid="production-export-title" value={title} onChange={(event) => setTitle(event.target.value)} className={textInputClass} />
          </label>
          <label className="flex min-w-[240px] flex-1 flex-col gap-0.5">
            <FieldLabel text="正文工件" />
            <select
              data-testid="production-export-manuscript"
              value={manuscriptArtifactId}
              onChange={(event) => setManuscriptArtifactId(event.target.value)}
              className={selectClass}
            >
              <option value="">— 选择正文工件 —</option>
              {manuscriptArtifacts.map((artifact) => (
                <option key={artifact.id} value={artifact.id}>
                  {artifact.title}（{artifact.status}）
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[220px] flex-1 flex-col gap-0.5">
            <FieldLabel text="模板" />
            <div className="flex items-center gap-2">
              <select
                data-testid="production-export-template"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                className={selectClass}
              >
                <option value="">默认模板（{language === 'zh' ? '中文' : '英文'}）</option>
                {(templates.data ?? []).map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.id}（{template.status}）
                  </option>
                ))}
              </select>
              {templateId.length === 0 ? (
                <select
                  data-testid="production-export-language"
                  value={language}
                  onChange={(event) => setLanguage(event.target.value as 'zh' | 'en')}
                  className="h-[var(--control-height)] rounded-control border border-line bg-bg px-2 text-ink"
                >
                  <option value="zh">zh</option>
                  <option value="en">en</option>
                </select>
              ) : null}
            </div>
          </label>
        </div>
        {templateId.length > 0 && templateSelection === null ? (
          <InlineHint
            text="这个模板还不能用于导出：`research.template.prepare` 需要「已编译且 sourceDigest 已知」的模板（乐观并发三元组）。先在模板面板编译成功，或改用默认模板。"
            testId="production-export-template-unavailable"
          />
        ) : null}
        {(figures.data ?? []).length === 0 ? null : (
          <div className="flex flex-col gap-0.5" data-testid="production-export-figures">
            <FieldLabel text="图稿（可多选）" />
            <div className="flex flex-wrap gap-1">
              {(figures.data ?? []).map((figure) => (
                <label key={figure.id} className="flex items-center gap-1.5 rounded-control border border-line px-1.5 py-0.5 text-[var(--font-micro-size)] text-muted">
                  <input
                    type="checkbox"
                    data-testid={`production-export-figure-${figure.id}`}
                    checked={figureIds.includes(figure.id)}
                    onChange={(event) =>
                      setFigureIds(event.target.checked ? [...figureIds, figure.id] : figureIds.filter((id) => id !== figure.id))
                    }
                  />
                  <span className="truncate">{figure.title}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {bundle.status === 'loading' ? <InlineHint text="正在读取导出清单…" /> : null}
        {bundle.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: bundle.error ?? '读取导出清单失败', retry: bundle.reload }} />
        ) : null}
        <IssueList issues={blockers} testId="production-export-issues" />
        <button
          type="button"
          data-testid="production-export-prepare-run"
          disabled={!canWrite || prepare.pending || blockers.length > 0}
          onClick={() => {
            void prepare
              .run({
                title: title.trim(),
                manuscriptArtifactId,
                figureIds,
                template: templateSelection ?? { kind: 'default', language }
              })
              .then((prepared) => {
                if (prepared !== null) {
                  setSelectedExportId(prepared.id);
                  exports.reload();
                }
              });
          }}
          className={primaryButtonClass}
        >
          准备导出包
        </button>
        {prepare.error === null ? null : <InlineHint text={prepare.error} testId="production-export-prepare-error" />}
      </PanelSection>

      <PanelSection
        title="导出包列表"
        hint="research.export.list"
        testId="production-export-list"
        action={{ label: '刷新', onClick: exports.reload, busy: exports.status === 'loading', testId: 'production-export-refresh' }}
      >
        {exports.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: exports.error ?? '读取导出包失败', retry: exports.reload }} />
        ) : null}
        {activeExport === null ? null : (
          <ProgressTask
            label={`准备中：${activeExport.request.title}`}
            detail="导出准备（无推送接口，轮询列表）"
            polling
            onCancel={() => void cancel.run(activeExport.id).then(() => exports.reload())}
            testId="production-export-progress"
          />
        )}
        {(exports.data ?? []).length === 0 ? (
          <EmptyState
            icon={Package}
            title="还没有导出包"
            description="先用上面的表单准备一次：正文 + 图稿 + 模板，然后在这里发布与交付。"
            compact
            testId="production-export-empty"
          />
        ) : (
          <ul className="flex flex-col gap-1" data-testid="production-export-list-items">
            {(exports.data ?? []).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 text-[var(--font-meta-size)]">
                <button
                  type="button"
                  data-testid={`production-export-select-${entry.id}`}
                  onClick={() => {
                    setSelectedExportId(entry.id);
                    setFileContent(null);
                  }}
                  className={entry.id === selected?.id ? secondaryButtonClass + ' border-line-strong text-ink' : secondaryButtonClass}
                >
                  {entry.request.title}
                </button>
                <span className="text-subtle">{exportStatusLabel(entry.status)}</span>
                <span className="text-subtle">发布状态 {exportApprovalLabel(entry.approval)}</span>
                <span className="text-subtle">文件 {entry.files.length}</span>
                <span className="text-subtle">{formatBeijingDateTime(entry.createdAt)}</span>
                {entry.error === null ? null : <span className="text-[var(--st-bad)]">{entry.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      {selected === null ? null : (
        <PanelSection title="导出包详情" hint="research.export.get / read / cancel / publish / write" testId="production-export-detail">
          <dl className="flex flex-col gap-0.5">
            <KeyValue label="状态" value={exportStatusLabel(selected.status)} />
            <KeyValue label="发布状态" value={exportApprovalLabel(selected.approval)} />
            <KeyValue label="源哈希" value={selected.sourceHash?.slice(0, 16) ?? '—'} />
            <KeyValue label="归档" value={selected.archive === null ? '—' : `${selected.archive.path} · ${formatBytes(selected.archive.size)}`} />
            <KeyValue label="产物工件" value={selected.artifactId ?? '—'} />
            <KeyValue label="结束" value={selected.endedAt === null ? '—' : formatBeijingDateTime(selected.endedAt)} />
          </dl>
          <div className="flex flex-wrap items-center gap-1.5 text-[var(--font-micro-size)]" data-testid="production-export-file-groups">
            <span className="text-subtle">LaTeX {fileGroups.latex.length}</span>
            <span className="text-subtle">PDF {fileGroups.pdf.length}</span>
            <span className="text-subtle">BibTeX {fileGroups.bibliography.length}</span>
            <span className="text-subtle">图片 {fileGroups.figure.length}</span>
            <span className="text-subtle">其它 {fileGroups.other.length}</span>
          </div>
          {selected.files.length === 0 ? (
            <InlineHint text="还没有文件。" />
          ) : (
            <ul className="flex flex-col gap-1" data-testid="production-export-files">
              {selected.files.map((file) => (
                <li key={file.path} className="flex items-center gap-2 text-[var(--font-meta-size)]">
                  <span className="min-w-0 flex-1 truncate font-mono text-ink" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-subtle">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    data-testid={`production-export-read-${file.path}`}
                    onClick={() => {
                      void readExportFile(scope.client, { projectId, exportId: selected.id, path: file.path }).then((result) => {
                        setFileContent(
                          result.ok
                            ? { path: file.path, content: result.data.content, encoding: result.data.encoding }
                            : { path: file.path, content: `读取失败：${result.error.message}`, encoding: 'utf8' }
                        );
                      });
                    }}
                    className={secondaryButtonClass}
                  >
                    读取
                  </button>
                </li>
              ))}
            </ul>
          )}
          {fileContent === null ? null : (
            <div className="flex flex-col gap-1 rounded-card border border-line bg-bg-soft px-2 py-1.5" data-testid="production-export-file-content">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-muted text-[var(--font-micro-size)]">{fileContent.path}</span>
                <span className="text-subtle text-[var(--font-micro-size)]">{fileContent.encoding}</span>
                <button type="button" onClick={() => setFileContent(null)} className="rounded-control px-1.5 text-subtle hover:text-ink">
                  关闭
                </button>
              </div>
              <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap font-mono text-[var(--code-text)] text-[var(--font-code-size)]">
                {fileContent.content}
              </pre>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {selected.status === 'preparing' ? (
              <button
                type="button"
                data-testid="production-export-cancel"
                disabled={cancel.pending}
                onClick={() => void cancel.run(selected.id).then(() => exports.reload())}
                className={secondaryButtonClass}
              >
                <XCircle size={11} aria-hidden="true" className="mr-1 inline" />
                取消
              </button>
            ) : null}
            {selected.status === 'ready' && selected.approval === 'unpublished' ? (
              <button
                type="button"
                data-testid="production-export-publish"
                disabled={!canWrite || publish.pending}
                onClick={() => void publish.run(selected.id).then(() => exports.reload())}
                className={primaryButtonClass}
              >
                发布（进入人工闸门）
              </button>
            ) : null}
          </div>
          {publish.error === null ? null : <InlineHint text={publish.error} testId="production-export-publish-error" />}

          <div className="flex flex-col gap-1" data-testid="production-export-delivery">
            <label className="flex flex-col gap-0.5">
              <FieldLabel text="交付到本机绝对路径（必须以 .zip 结尾）" />
              <input
                data-testid="production-export-destination"
                value={destinationPath}
                placeholder="/Users/you/Downloads/export.zip"
                onChange={(event) => setDestinationPath(event.target.value)}
                className={textInputClass}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[var(--font-micro-size)] text-muted">
              <input
                type="checkbox"
                data-testid="production-export-delivery-ack"
                checked={deliveryAcknowledged}
                onChange={(event) => setDeliveryAcknowledged(event.target.checked)}
              />
              我知道这会把归档写到工作目录之外（后端任务单 B22：契约里没有「另存为」对话框）。
            </label>
            <button
              type="button"
              data-testid="production-export-write"
              disabled={!canWrite || deliver.pending || !deliveryAcknowledged || !destinationPath.trim().endsWith('.zip')}
              onClick={() => {
                void deliver.run(selected.id).then((result) => {
                  if (result !== null) {
                    setDelivery(result);
                    exports.reload();
                  }
                });
              }}
              className={secondaryButtonClass + ' self-start'}
            >
              <Send size={11} aria-hidden="true" className="mr-1 inline" />
              交付（research.export.write）
            </button>
            {delivery === null ? null : (
              <p className="font-mono text-muted text-[var(--font-micro-size)]" data-testid="production-export-delivery-result">
                已交付：{delivery.destinationPath} · {formatBytes(delivery.size)} · {delivery.sha256.slice(0, 12)}
              </p>
            )}
            {deliver.error === null ? null : <InlineHint text={deliver.error} testId="production-export-delivery-error" />}
          </div>
        </PanelSection>
      )}
    </div>
  );
}
