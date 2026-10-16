import { lazy, Suspense, useEffect, useState } from 'react';
import { FileCode2, Plus } from 'lucide-react';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import { useWorkspaceScope } from '../../app/workspace-scope';
import { ErrorBar } from '../../shell/ErrorBar';
import { DelayedFallback } from '../../shell/DelayedFallback';
import { formatBeijingDateTime } from '../../shared/format';
import { currentArtifacts, stageGroupWriteAllowed, type ResearchStageGroupId } from './workflow-rules';
import {
  researchArtifactKindLabels,
  researchArtifactStatusLabels,
  researchStageOutputs
} from './format';
import { useWorkflow } from './workflow-scope';
import { createArtifact, getArtifactContent, updateArtifact } from './workflow-store';
import { ProductionInputPanel } from './ProductionInputPanel';

/**
 * 工件面板 (P6/T6.5).
 *
 * Contents come from `research.artifacts.list` / `getArtifactContent`; the list is already
 * loaded in the shared workflow store, so this panel only fetches the **content** of the one
 * artifact that is selected.
 *
 * Four honest cases, each with its own wording rather than one empty table:
 *
 *   1. the stage has no artifacts yet;
 *   2. the artifact is a **manual** one, so `getArtifactContent` answers `null` — content is
 *      only ever written by a stage run (`run-repository.attachOutput`);
 *   3. the artifact was produced by a run → its Markdown, claims/sections and raw JSON;
 *   4. the artifact backs a production run → `ProductionInputPanel` (T6.5's second half).
 *
 * Writes (create / rename) are gated by `stageGroupWriteAllowed` **and** the project's
 * archived flag, which is the same pair the stage bar shows: a form that is visible but
 * refused by the backend is worse than a disabled one with a reason.
 *
 * Markdown is a **lazy** import of the assistant's renderer. That keeps `react-markdown` +
 * `highlight.js` out of this view's chunk while reusing one implementation instead of a
 * second, divergent renderer (D3: reuse, do not rewrite).
 */

const MarkdownView = lazy(async () => ({ default: (await import('../../assistant/blocks/markdown-view')).MarkdownView }));

export function ArtifactPanel({ groupId }: { groupId: ResearchStageGroupId }): React.JSX.Element {
  const scope = useWorkspaceScope();
  const store = useWorkflow();
  const workflow = store.workflow;
  const artifacts = workflow === null ? [] : currentArtifacts(store.artifacts, workflow);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const currentStage = workflow?.currentStage ?? null;
  // A new stage is a new artifact set: keeping the previous selection would show another
  // stage's artifact under the new stage's header.
  useEffect(() => {
    setSelectedId(null);
    setDraftTitle('');
  }, [currentStage]);

  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? null;

  const content = useAsyncResource(
    selected === null ? null : `artifact-content:${selected.id}`,
    () => getArtifactContent(scope.client, selected?.projectId ?? '', selected?.id ?? ''),
    { label: '读取产物内容' }
  );

  const create = useAsyncAction(
    (title: string) =>
      createArtifact(scope.client, {
        projectId: workflow?.projectId ?? '',
        stage: workflow?.currentStage ?? 'discovery',
        kind: store.role?.outputKind ?? 'search_strategy',
        title,
        // File-backed artifacts are P7's (manuscript / template) concern; a text artifact
        // here has no path, which the contract models as `null`.
        path: null
      }),
    { label: '新建产物' }
  );
  const rename = useAsyncAction(
    (input: { id: string; title: string }) => updateArtifact(scope.client, input),
    { label: '修改产物标题' }
  );

  if (workflow === null || store.project === null) {
    return (
      <p className="text-muted text-[var(--font-meta-size)]" role="status">
        正在读取阶段状态…
      </p>
    );
  }

  // The **viewed** group decides writability, not the current one: browsing 写作与审阅 while the
  // project is in 发现 must stay read-only even though the current group is writable (T6.3).
  const currentStatus = workflow.stages.find((stage) => stage.stage === workflow.currentStage)?.status;
  const writeAllowed = scope.writable && stageGroupWriteAllowed(groupId, workflow.currentStage, currentStatus);

  const onCreate = async (): Promise<void> => {
    const title = draftTitle.trim();
    if (title.length === 0) {
      return;
    }
    const created = await create.run(title);
    if (created !== null) {
      setDraftTitle('');
      setSelectedId(created.id);
      store.refresh();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3" data-testid="workflow-artifacts">
      <div className="flex w-[260px] shrink-0 flex-col gap-2">
        <header className="flex items-center justify-between gap-2">
          <span className="text-subtle text-[var(--font-micro-size)]">
            本阶段产物（{artifacts.length}）
          </span>
          <span className="text-subtle text-[var(--font-micro-size)]">
            输出类型：{researchStageOutputs[workflow.currentStage]}
          </span>
        </header>
        {artifacts.length === 0 ? (
          <p className="text-muted text-[var(--font-meta-size)]" role="status" data-testid="workflow-artifacts-empty">
            还没有产物：本阶段的运行完成后，产物会出现在这里。
          </p>
        ) : (
          <ul className="flex flex-col gap-1 overflow-y-auto" data-testid="workflow-artifact-list">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  data-testid={`workflow-artifact-${artifact.id}`}
                  data-selected={artifact.id === selectedId ? 'true' : 'false'}
                  onClick={() => setSelectedId(artifact.id)}
                  className={[
                    'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-control border px-2 py-1.5 text-left',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                    artifact.id === selectedId
                      ? 'border-line-strong bg-surface'
                      : 'border-transparent hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                  ].join(' ')}
                >
                  <span className="w-full truncate text-ink" title={artifact.title}>
                    {artifact.title}
                  </span>
                  <span className="text-subtle text-[var(--font-micro-size)]">
                    {researchArtifactKindLabels[artifact.kind]} · {researchArtifactStatusLabels[artifact.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <section className="flex flex-col gap-1 rounded-card border border-line bg-surface px-2.5 py-2" data-testid="workflow-artifact-create">
          <span className="text-subtle text-[var(--font-micro-size)]">手工新建产物</span>
          <input
            type="text"
            value={draftTitle}
            data-testid="workflow-artifact-create-title"
            disabled={!writeAllowed}
            placeholder={writeAllowed ? '产物标题' : '当前不可写（非当前阶段或项目已归档）'}
            onChange={(event) => setDraftTitle(event.target.value)}
            className="h-[var(--control-height)] w-full rounded-control border border-line bg-bg px-2 text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
          <button
            type="button"
            data-testid="workflow-artifact-create-submit"
            disabled={!writeAllowed || create.pending || draftTitle.trim().length === 0}
            onClick={() => void onCreate()}
            className="flex h-[var(--control-height-compact)] items-center gap-1 self-start rounded-control border border-line px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50"
          >
            <Plus size={12} aria-hidden="true" />
            新建
          </button>
          {writeAllowed ? (
            <p className="text-subtle text-[var(--font-micro-size)]">
              手工产物没有阶段运行内容：内容由 research.workflow.startRun 的运行写出。
            </p>
          ) : (
            <p className="text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="workflow-artifact-create-readonly">
              只读：非当前阶段不可写，项目设置组除外；归档项目整体只读。
            </p>
          )}
          {create.error === null ? null : <p className="text-[var(--st-bad)] text-[var(--font-micro-size)]">{create.error}</p>}
        </section>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
        {selected === null ? (
          <p className="text-muted text-[var(--font-meta-size)]" role="status">
            选择一个产物查看内容。
          </p>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                defaultValue={selected.title}
                key={`${selected.id}:${selected.updatedAt}`}
                data-testid="workflow-artifact-title"
                disabled={!writeAllowed}
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next.length === 0 || next === selected.title) {
                    return;
                  }
                  void rename.run({ id: selected.id, title: next }).then((updated) => {
                    if (updated !== null) {
                      store.refresh();
                    }
                  });
                }}
                className="h-[var(--control-height)] min-w-0 flex-1 rounded-control border border-line bg-bg px-2 text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              />
              <span className="text-subtle text-[var(--font-micro-size)]">
                {researchArtifactKindLabels[selected.kind]} · {researchArtifactStatusLabels[selected.status]} · 更新于{' '}
                {formatBeijingDateTime(selected.updatedAt)}
              </span>
            </header>
            {rename.error === null ? null : <p className="text-[var(--st-bad)] text-[var(--font-micro-size)]">{rename.error}</p>}

            {content.status === 'loading' ? (
              <p className="text-muted text-[var(--font-meta-size)]" role="status">
                正在读取产物内容…
              </p>
            ) : null}
            {content.status === 'error' ? (
              <ErrorBar
                error={{
                  level: 'page',
                  message: content.error ?? '读取产物内容失败',
                  retry: content.reload,
                  actionLabel: 'research.artifacts.content'
                }}
              />
            ) : null}
            {content.status === 'ready' && content.data === null ? (
              <p className="text-muted text-[var(--font-meta-size)]" role="status" data-testid="workflow-artifact-no-content">
                这个产物没有阶段运行内容（手工新建的产物就是这样）：它只有标题与状态，正文由阶段运行写入。
              </p>
            ) : null}

            {content.data === null ? null : (
              <section className="flex flex-col gap-2" data-testid="workflow-artifact-content">
                <div className="flex flex-wrap items-center gap-2 text-[var(--font-micro-size)] text-subtle">
                  <span>结论：{content.data.output.verdict}</span>
                  <span>主张 {content.data.output.claims.length}</span>
                  <span>章节 {content.data.output.sections.length}</span>
                  <span className="font-mono">运行 {content.data.runId}</span>
                </div>
                <article className="rounded-card border border-line bg-surface px-3 py-2.5">
                  <Suspense fallback={<DelayedFallback label="正在加载 Markdown 渲染器…" />}>
                    <MarkdownView text={content.data.output.markdown} />
                  </Suspense>
                </article>
                {content.data.output.claims.length === 0 ? null : (
                  <section className="rounded-card border border-line bg-surface px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-subtle text-[var(--font-micro-size)]">
                      <FileCode2 size={12} aria-hidden="true" />
                      结构化主张（直接来自 research.artifacts.content）
                    </div>
                    <ul className="mt-1 flex flex-col gap-1">
                      {content.data.output.claims.map((claim, index) => (
                        <li key={`${claim.subjectType}-${index}`} className="text-[var(--font-meta-size)] text-muted">
                          <span className="text-subtle">{claim.subjectType}</span> ·{' '}
                          <span className="text-ink">{claim.content}</span> ·{' '}
                          <span className="text-subtle">
                            {claim.status} · 证据 {claim.evidenceIds.length}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <details className="rounded-card border border-line bg-surface px-3 py-2">
                  <summary className="cursor-pointer text-muted text-[var(--font-meta-size)]">原始 JSON</summary>
                  <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap font-mono text-[var(--code-text)] text-[var(--font-code-size)]">
                    {JSON.stringify(content.data, null, 2)}
                  </pre>
                </details>
              </section>
            )}

            <ProductionInputPanel artifact={selected} />
          </>
        )}
      </div>
    </div>
  );
}
