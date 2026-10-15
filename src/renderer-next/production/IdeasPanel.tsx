import { useMemo, useState } from 'react';
import { ArrowUpRight, History, Lightbulb, RotateCcw } from 'lucide-react';
import type { ResearchIdeaCanvas } from '../../shared/types';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime } from '../shared/format';
import { useWorkflow } from '../canvas/workflow/workflow-scope';
import {
  IDEA_REQUIRED_KEYS,
  emptyIdeaSections,
  ideaCanvasFields,
  ideaFieldLabel,
  ideaSectionsFromCanvas,
  ideaSaveBlockers,
  type IdeaFieldDraft,
  type IdeaFieldKey
} from './production-rules';
import { getIdeaCanvas, listIdeaCanvasHistory, promoteIdeaCanvas, saveIdeaCanvas } from './production-store';
import {
  FieldLabel,
  InlineHint,
  IssueList,
  PanelSection,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  textAreaClass,
  textInputClass
} from './panel-shell';

/**
 * 构思 (P7/T7.1) — Idea Canvas.
 *
 * The canvas hangs off an **artifact** (`research.ideas.get` takes `{artifactId}`), so the panel
 * works on the current stage's `idea_canvas` artifact and says so when there is none.
 *
 * Two contract constraints drive the editor's shape:
 *
 *  1. **`fields` is derived, never edited.** `save` requires exactly seven fields whose `content`
 *     is byte-identical to the named sections; the `status`/`evidenceIds` of each field are kept
 *     from the loaded version (`ideaCanvasFields`). Editing both copies would fail validation the
 *     moment they drifted.
 *  2. **`expectedVersion` is the concurrency token** — `null` for the first save, otherwise the
 *     loaded version. A save that loses the race surfaces the backend's refusal instead of
 *     overwriting a newer canvas.
 *
 * Promotion creates a **new project** and needs a workspace path that no other project owns
 * (`createProject` rejects a taken path). The path therefore comes from the native directory
 * panel, never from typing (R10/ADR-M06), and the panel explains why it must be a new directory.
 */

export function IdeasPanel(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const workflow = useWorkflow();
  const artifact = useMemo(
    () => (workflow.artifacts ?? []).find((item) => item.kind === 'idea_canvas') ?? null,
    [workflow.artifacts]
  );

  const canvas = useAsyncResource<ResearchIdeaCanvas | null>(
    artifact === null ? null : `idea:${artifact.id}`,
    () => getIdeaCanvas(scope.client, artifact?.id ?? ''),
    { label: '读取构思画布' }
  );

  const [sections, setSections] = useState<Record<IdeaFieldKey, string> | null>(null);
  const [priority, setPriority] = useState<ResearchIdeaCanvas['priority']>('medium');
  const [rationale, setRationale] = useState('');
  const [fields, setFields] = useState<IdeaFieldDraft[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const loaded = canvas.data ?? null;
  /** The editor starts from the loaded canvas (or an empty one) the first time it is touched. */
  const currentSections = sections ?? (loaded === null ? emptyIdeaSections() : ideaSectionsFromCanvas(loaded));
  const currentPriority = sections === null && loaded !== null ? loaded.priority : priority;
  const currentRationale = sections === null && loaded !== null ? loaded.rationale : rationale;
  const currentFields = fields.length > 0 ? fields : (loaded?.fields ?? []);

  const history = useAsyncResource<ResearchIdeaCanvas[]>(
    artifact === null || !historyOpen ? null : `idea-history:${artifact.id}`,
    () => listIdeaCanvasHistory(scope.client, artifact?.id ?? ''),
    { label: '读取构思历史' }
  );

  const save = useAsyncAction(
    (input: { sections: Record<IdeaFieldKey, string>; priority: ResearchIdeaCanvas['priority']; rationale: string; fields: IdeaFieldDraft[] }) =>
      saveIdeaCanvas(scope.client, {
        artifactId: artifact?.id ?? '',
        expectedVersion: loaded === null ? null : loaded.version,
        ...input.sections,
        priority: input.priority,
        rationale: input.rationale,
        fields: input.fields
      }),
    { label: '保存构思画布' }
  );

  const promote = useAsyncAction(
    (workspacePath: string) =>
      promoteIdeaCanvas(scope.client, {
        artifactId: artifact?.id ?? '',
        expectedVersion: loaded?.version ?? 0,
        title: artifact?.title,
        workspacePath
      }),
    { label: '晋升为新项目' }
  );
  const [promoted, setPromoted] = useState<{ projectId: string; origin: string } | null>(null);

  const writable = scope.writable;

  if (artifact === null) {
    return (
      <div className="flex h-full flex-col justify-center" data-testid="production-ideas">
        <EmptyState
          icon={Lightbulb}
          title="本阶段还没有构思工件"
          description="Idea Canvas 挂在构思阶段的 idea_canvas 工件上。先让构思阶段跑一次，工件出现后这里就能编辑。"
          testId="production-ideas-empty"
        />
      </div>
    );
  }

  if (canvas.status === 'error') {
    return (
      <div className="flex h-full flex-col gap-2 p-1" data-testid="production-ideas">
        <ErrorBar error={{ level: 'page', message: canvas.error ?? '读取构思画布失败', retry: canvas.reload }} />
      </div>
    );
  }

  const blockers = ideaSaveBlockers(currentSections, currentRationale);

  const onSave = (): void => {
    const nextFields = ideaCanvasFields(currentSections, currentFields);
    void save
      .run({ sections: currentSections, priority: currentPriority, rationale: currentRationale, fields: nextFields })
      .then((saved) => {
        if (saved !== null) {
          setSections(null);
          setFields([]);
          canvas.reload();
        }
      });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="production-ideas">
      <PanelSection
        title="Idea Canvas"
        hint={loaded === null ? '还没有保存过版本' : `v${loaded.version} · 更新于 ${formatBeijingDateTime(loaded.updatedAt)}`}
        testId="production-idea-canvas"
        action={{
          label: historyOpen ? '隐藏历史' : '历史版本',
          onClick: () => setHistoryOpen((open) => !open),
          testId: 'production-idea-history-toggle'
        }}
      >
        {loaded === null ? (
          <InlineHint text="空画布：从问题与假设写起，保存后版本号从 1 开始（expectedVersion=null）。" testId="production-idea-new" />
        ) : null}
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {(Object.keys(currentSections) as IdeaFieldKey[]).map((key) => (
            <label key={key} className="flex flex-col gap-0.5">
              <FieldLabel
                text={`${ideaFieldLabel(key)}${IDEA_REQUIRED_KEYS.includes(key) ? '（必填）' : '（可选）'}`}
              />
              <textarea
                data-testid={`production-idea-field-${key}`}
                value={currentSections[key]}
                rows={3}
                disabled={!writable}
                onChange={(event) => setSections({ ...currentSections, [key]: event.target.value })}
                className={textAreaClass}
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex w-[160px] flex-col gap-0.5">
            <FieldLabel text="优先级" />
            <select
              data-testid="production-idea-priority"
              value={currentPriority}
              disabled={!writable}
              onChange={(event) => {
                setSections({ ...currentSections });
                setPriority(event.target.value as ResearchIdeaCanvas['priority']);
              }}
              className={selectClass}
            >
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </label>
          <label className="flex min-w-[240px] flex-1 flex-col gap-0.5">
            <FieldLabel text="立项理由（必填）" />
            <input
              data-testid="production-idea-rationale"
              value={currentRationale}
              disabled={!writable}
              onChange={(event) => {
                setSections({ ...currentSections });
                setRationale(event.target.value);
              }}
              className={textInputClass}
            />
          </label>
        </div>
        <IssueList issues={blockers} testId="production-idea-issues" />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="production-idea-save"
            disabled={!writable || save.pending || blockers.length > 0}
            onClick={onSave}
            className={primaryButtonClass}
          >
            {loaded === null ? '保存画布' : `保存为新版本（当前 v${loaded.version}）`}
          </button>
          {writable ? null : (
            <span className="text-[var(--font-micro-size)] text-subtle" data-testid="production-idea-readonly">
              项目已归档：构思画布只读。
            </span>
          )}
        </div>
        {save.error === null ? null : <InlineHint text={save.error} testId="production-idea-save-error" />}
      </PanelSection>

      {historyOpen ? (
        <PanelSection
          title="历史版本（只读）"
          hint="research.ideas.history"
          testId="production-idea-history"
        >
          {history.status === 'error' ? (
            <ErrorBar error={{ level: 'page', message: history.error ?? '读取历史失败', retry: history.reload }} />
          ) : null}
          {(history.data ?? []).length === 0 ? (
            <InlineHint text="还没有历史版本。" />
          ) : (
            <ol className="flex flex-col gap-1" data-testid="production-idea-history-list">
              {(history.data ?? []).map((version) => (
                <li key={`${version.artifactId}-${version.version}`} className="flex items-start gap-2 text-[var(--font-meta-size)]">
                  <History size={11} aria-hidden="true" className="mt-0.5 shrink-0 text-subtle" />
                  <span className="shrink-0 font-mono text-subtle">v{version.version}</span>
                  <span className="min-w-0 flex-1 truncate text-muted" title={version.problem}>
                    {version.problem}
                  </span>
                  <span className="shrink-0 text-subtle">{version.priority}</span>
                  <span className="shrink-0 text-subtle">{formatBeijingDateTime(version.updatedAt)}</span>
                  <button
                    type="button"
                    data-testid={`production-idea-history-load-${version.version}`}
                    className={secondaryButtonClass}
                    onClick={() => {
                      // Load into the editor only: rolling *back* is a save that creates a new
                      // version (the backend has no revert), so the button restores text, it does
                      // not pretend to undo.
                      setSections(ideaSectionsFromCanvas(version));
                      setPriority(version.priority);
                      setRationale(version.rationale);
                      setFields(version.fields);
                    }}
                  >
                    <RotateCcw size={11} aria-hidden="true" />
                    载入编辑
                  </button>
                </li>
              ))}
            </ol>
          )}
        </PanelSection>
      ) : null}

      <PanelSection
        title="晋升为新项目"
        hint="research.ideas.promote（新项目 origin 指向本稿）"
        testId="production-idea-promote"
      >
        {loaded === null ? (
          <InlineHint text="先保存画布，再晋升。" />
        ) : (
          <>
            <p className="text-muted text-[var(--font-meta-size)]">
              晋升会创建一个新项目，并把 `origin` 指向本画布（v{loaded.version}）。新项目需要一个**别的项目没有用过**的工作目录。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="production-idea-promote-pick"
                disabled={!writable || promote.pending}
                onClick={() => {
                  void scope.client.api.workspace.selectFromDialog().then((result) => {
                    if (!result.ok || result.data === null) {
                      return;
                    }
                    void promote.run(result.data.path).then((promotion) => {
                      if (promotion !== null) {
                        setPromoted({ projectId: promotion.project.id, origin: promotion.project.origin?.artifactId ?? '—' });
                      }
                    });
                  });
                }}
                className={secondaryButtonClass}
              >
                <ArrowUpRight size={11} aria-hidden="true" />
                选择新工作目录并晋升
              </button>
              {promoted === null ? null : (
                <span className="font-mono text-muted text-[var(--font-micro-size)]" data-testid="production-idea-promoted">
                  已晋升：项目 {promoted.projectId} · origin {promoted.origin}
                </span>
              )}
            </div>
            {promote.error === null ? null : <InlineHint text={promote.error} testId="production-idea-promote-error" />}
          </>
        )}
      </PanelSection>
    </div>
  );
}
