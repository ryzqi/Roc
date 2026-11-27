import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './project-workspace.css';
import { LayoutGrid, List, Loader2, Plus, Search } from 'lucide-react';
import type { ResearchProject } from '../../shared/types';
import { readProjectView, writeProjectView, readRecentProjectIds, type ProjectView } from '../app/ui-state';
import { projectStageLabel } from './project-store';
import { ErrorBar } from '../shell/ErrorBar';
import { EmptyState } from '../shell/EmptyState';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { formPrimaryButtonClass } from '../shared/form-ui';
import {PageHeader} from '../shared/page-ui';
import { ProjectRow } from './ProjectRow';
import { ProjectFormDialog, type ProjectFormValues } from './ProjectFormDialog';
import { isProjectArchived, visibleProjects, type ProjectStatusFilter } from './project-store';
import { useProjects } from './use-projects';
import type { RocClient } from '../shared/roc-client';
import { motionDurationSeconds, motionTransitions } from '../shared/motion';
import { useEffectiveReducedMotion } from '../shared/motion-preference';

/**
 * Project portal (P2/T2.2–T2.6).
 *
 * Real SQLite-backed projects via `research.projects.*`. Three product rules are
 * enforced here rather than left to the reader:
 *
 *   - **no `localStorage` project data** — the old `codex_projects_list` /
 *     `codex_project_data_*` semantics are gone entirely; only the local pin list
 *     remains, and it is labelled "本机置顶" because the backend has no star field
 *     (B1). Pinning reorders, never filters.
 *   - **"进行中" means not archived**, not `status === 'active'` — a paused or
 *     completed project is still work in progress for the person looking at it.
 *   - **creating requires a workspace directory** chosen through the native panel;
 *     one directory belongs to one project, and a conflict is the backend's error
 *     shown verbatim.
 *
 * Card counts (`paperCount` / `fileCount` / `wordCount`) from the old frontend are
 * not rendered: they were fabricated. They can come back only via a real lazy
 * call at the point of display.
 */

export type ProjectPortalViewProps = {
  client: RocClient;
  /** One-shot request from the route (`page=research-new` / ⌘N). */
  createFormRequested: boolean;
  onRequestConsumed: (requested: boolean) => void;
  onOpenProject: (projectId: string) => void;
};

const STATUS_FILTERS: Array<{ id: ProjectStatusFilter; label: string }> = [
  { id: 'active', label: '进行中' },
  { id: 'archived', label: '已归档' },
  { id: 'all', label: '全部' }
];

type ProjectRowRect = { element: HTMLDivElement; rect: DOMRect };
type PinSnapshot = {
  projects: readonly ResearchProject[];
  query: string;
  filter: ProjectStatusFilter;
  view: ProjectView;
  width: number;
  ids: readonly string[];
  rows: Map<string, ProjectRowRect>;
};

function visibleRowRects(list: HTMLDivElement, scrollArea: HTMLDivElement): Map<string, ProjectRowRect> {
  const viewport = scrollArea.getBoundingClientRect();
  const top = Math.max(0, viewport.top);
  const bottom = Math.min(window.innerHeight, viewport.bottom);
  const left = Math.max(0, viewport.left);
  const right = Math.min(window.innerWidth, viewport.right);
  const rows = new Map<string, ProjectRowRect>();
  for (const element of list.querySelectorAll<HTMLDivElement>(':scope > [data-project-id]')) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right) {
      rows.set(element.dataset.projectId!, { element, rect });
    }
  }
  return rows;
}

export function ProjectPortalView({
  client,
  createFormRequested,
  onRequestConsumed,
  onOpenProject
}: ProjectPortalViewProps): React.JSX.Element {
  const reducedMotion = useEffectiveReducedMotion();
  const projects = useProjects(client);
  const [projectView, setProjectView] = useState<ProjectView>(readProjectView);
  const [recentIds] = useState(readRecentProjectIds);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectStatusFilter>('active');
  const [createOpen, setCreateOpen] = useState(createFormRequested);
  const [editing, setEditing] = useState<ResearchProject | null>(null);
  const [archiving, setArchiving] = useState<ResearchProject | null>(null);
  const [deleting, setDeleting] = useState<ResearchProject | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIndex = useRef(0);
  const [visibleLimit, setVisibleLimit] = useState(40);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const pinSnapshot = useRef<PinSnapshot | null>(null);
  const pinAnimations = useRef<Animation[]>([]);
  const pinFocus = useRef<HTMLElement | null>(null);
  const cancelPinMotion = useCallback((): void => {
    pinSnapshot.current = null;
    pinFocus.current = null;
    for (const animation of pinAnimations.current) animation.cancel();
    pinAnimations.current = [];
  }, []);

  useEffect(() => {
    window.addEventListener('resize', cancelPinMotion);
    return () => {
      window.removeEventListener('resize', cancelPinMotion);
      cancelPinMotion();
    };
  }, [cancelPinMotion]);

  // Adopt later requests (a second ⌘N after the user closed the form).
  if (createFormRequested && !createOpen) {
    setCreateOpen(true);
  }

  const all = projects.list.data ?? [];
  const recent = recentIds.flatMap(id => {
    const project = all.find(item => item.id === id && !isProjectArchived(item));
    return project === undefined ? [] : [project];
  }).slice(0, 3);
  const shown = useMemo(
    () => visibleProjects(all, { query, filter, pinnedIds: projects.pinnedIds }),
    [all, query, filter, projects.pinnedIds]
  );

  /**
   * Clamped during render, not only inside the key handler.
   *
   * The visible set can shrink underneath the cursor (archiving or deleting under
   * 进行中, or a refresh after an edit). Without this clamp no card would match the
   * focused ID. Preserve that project through reordering, then use the nearest
   * index if it disappears so the primary action remains keyboard reachable.
   */
  const identityIndex = shown.findIndex(project => project.id === focusedId);
  const safeFocusedIndex = identityIndex >= 0 ? identityIndex : shown.length === 0 ? 0 : Math.min(focusedIndex.current, shown.length - 1);
  focusedIndex.current = safeFocusedIndex;
  const rendered = shown.slice(0, Math.max(visibleLimit, safeFocusedIndex + 1));
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const target = listRef.current?.querySelector<HTMLButtonElement>(`[data-project-id="${CSS.escape(pendingFocus.current)}"] [data-project-body]`);
    if (target === null || target === undefined) return;
    pendingFocus.current = null;
    target.focus();
  }, [visibleLimit, safeFocusedIndex, shown]);

  const resetListFocus = (): void => {
    focusedIndex.current = 0;
    setFocusedId(null);
    setVisibleLimit(40);
  };

  const togglePin = (id: string): void => {
    const list = listRef.current;
    const scrollArea = scrollRef.current;
    const active = document.activeElement;
    // Capture visual positions before cancelling an unfinished reorder, so reversal is continuous.
    const snapshot = all.length <= 20 && list !== null && scrollArea !== null
      ? { projects: all, query, filter, view: projectView, width: list.clientWidth,
        ids: rendered.map(project => project.id), rows: visibleRowRects(list, scrollArea) }
      : null;
    cancelPinMotion();
    pinSnapshot.current = snapshot;
    pinFocus.current = active instanceof HTMLElement && list?.contains(active) ? active : null;
    projects.togglePin(id);
  };

  useLayoutEffect(() => {
    const snapshot = pinSnapshot.current;
    const focus = pinFocus.current;
    cancelPinMotion();
    if (focus?.isConnected && document.activeElement === document.body) focus.focus({ preventScroll: true });
    const list = listRef.current;
    const scrollArea = scrollRef.current;
    if (snapshot === null || list === null || scrollArea === null || snapshot.projects !== all
      || snapshot.query !== query || snapshot.filter !== filter || snapshot.view !== projectView || snapshot.width !== list.clientWidth) return;
    const ids = new Set(rendered.map(project => project.id));
    if (ids.size !== snapshot.ids.length || snapshot.ids.some(id => !ids.has(id))) return;
    for (const [id, { element, rect }] of visibleRowRects(list, scrollArea)) {
      const before = snapshot.rows.get(id);
      if (before === undefined) continue;
      const x = before.rect.left - rect.left;
      const y = before.rect.top - rect.top;
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
      pinAnimations.current.push(element.animate(reducedMotion
        ? [{ opacity: 0.8 }, { opacity: 1 }]
        : [{ translate: `${x}px ${y}px` }, { translate: '0px 0px' }], {
        duration: (reducedMotion ? motionDurationSeconds.reduced : motionTransitions['list-small'].duration) * 1000,
        easing: `cubic-bezier(${motionTransitions['list-small'].ease.join(', ')})`
      }));
    }
  }, [all, shown, query, filter, projectView, visibleLimit, cancelPinMotion, reducedMotion]);

  const closeCreate = (): void => {
    setCreateOpen(false);
    if (createFormRequested) {
      onRequestConsumed(false);
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (shown.length === 0) {
      return;
    }
    // Keep arrow navigation on the project rows; row action buttons retain normal key behavior.
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('[data-project-body]') === null) {
      return;
    }
    const columns = projectView === 'cards' && listRef.current !== null
      ? getComputedStyle(listRef.current).gridTemplateColumns.split(' ').length : 1;
    const delta = event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns
      : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0 && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 :
      Math.min(Math.max(safeFocusedIndex + delta, 0), shown.length - 1);
    const nextProject = shown[next];
    if (nextProject === undefined) return;
    if (next >= rendered.length) setVisibleLimit(Math.min(shown.length, Math.max(next + 1, visibleLimit + 40)));
    pendingFocus.current = nextProject.id;
    setFocusedId(nextProject.id);
    const nextButton = listRef.current?.querySelector<HTMLButtonElement>(`[data-project-index="${next}"] [data-project-body]`);
    if (nextButton !== null && nextButton !== undefined) {
      pendingFocus.current = null;
      nextButton.focus();
    }
  };

  const busy = projects.create.pending || projects.update.pending || projects.remove.pending;
  const writeError = editing === null && archiving === null ? projects.update.error : null;

  const submitCreate = async (values: ProjectFormValues): Promise<void> => {
    const created = await projects.create.run({
      title: values.title,
      description: values.description,
      workspacePath: values.workspacePath,
      language: values.language
    });
    if (!created.ok) {
      return;
    }
    closeCreate();
    onOpenProject(created.data.id);
  };

  const submitEdit = async (values: ProjectFormValues): Promise<void> => {
    if (editing === null) {
      return;
    }
    const workspacePath = values.workspacePath.trim();
    const updated = await projects.update.run({
      id: editing.id,
      title: values.title,
      description: values.description,
      // `researchProjectUpdateRequestSchema` types `workspacePath` as
      // `string().trim().min(1).optional()`: sending the empty string that an
      // unbound project's form seeds would fail validation, so the key is omitted
      // when there is nothing to bind. Omitting it also preserves the stored value,
      // which is what "unbound stays unbound" means here.
      ...(workspacePath.length > 0 ? { workspacePath } : {}),
      // `language` is intentionally absent: the product fixes it at creation even
      // though the backend would accept a change (see `isLanguageLocked`).
    });
    if (!updated.ok) {
      return;
    }
    setEditing(null);
  };

  return (
    <div className="project-portal h-full" data-testid="portal" onScrollCapture={cancelPinMotion}>
      <div className="project-portal-header" data-testid="portal-header">
        <div className="project-portal-heading">
          <PageHeader title="研究项目" action={<button type="button" data-testid="portal-new-project" aria-label="新建研究项目" onClick={() => setCreateOpen(true)}
              className={formPrimaryButtonClass}>
              <Plus size={14} aria-hidden="true" />{all.length === 0 && projects.list.status === 'ready' ? '新建第一个研究项目' : '新建项目'}
            </button>}/>
          {all.length > 0 ? (
            <div className="project-portal-filters">
              <div className="flex min-h-[var(--control-height)] min-w-[min(160px,100%)] flex-1 items-center gap-2 rounded-control border-[0.5px] border-line bg-surface px-2">
                <Search size={13} aria-hidden="true" className="shrink-0 text-subtle" />
                <input
                  value={query}
                  onChange={(event) => {
                    cancelPinMotion();
                    setQuery(event.target.value);
                    resetListFocus();
                  }}
                  placeholder="搜索项目"
                  aria-label="搜索项目"
                  data-testid="portal-search"
                  className="min-h-6 min-w-0 flex-1 bg-transparent text-ink placeholder:text-subtle"
                />
                {query.length === 0 ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      cancelPinMotion();
                      setQuery('');
                      resetListFocus();
                    }}
                    className="min-h-6 shrink-0 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
                  >
                    清空
                  </button>
                )}
              </div>
              <div role="group" aria-label="项目状态筛选" className="flex items-center gap-0.5 rounded-control bg-[var(--overlay-hover)] p-0.5">
                {STATUS_FILTERS.map((entry) => {
                  const selected = entry.id === filter;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        cancelPinMotion();
                        setFilter(entry.id);
                        resetListFocus();
                      }}
                      data-testid={`portal-filter-${entry.id}`}
                      className={
                        selected
                          ? 'h-[var(--control-height-compact)] rounded-chip bg-surface px-2.5 font-medium text-ink active:bg-[var(--accent-soft-strong)]'
                          : 'h-[var(--control-height-compact)] rounded-chip px-2.5 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                      }
                    >
                      <span className="text-[length:var(--font-meta-size)]">{entry.label}</span>
                    </button>
                  );
                })}
              </div>
              <div role="group" aria-label="项目显示方式" className="flex items-center gap-0.5">
                {([['cards', '卡片视图', LayoutGrid], ['list', '紧凑列表', List]] as const).map(([id, label, Icon]) => (
                  <button key={id} type="button" aria-label={label} title={label} aria-pressed={projectView === id}
                    data-testid={`portal-view-${id}`} onClick={() => { cancelPinMotion(); setProjectView(id); writeProjectView(id); }}
                    className="flex h-7 w-7 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)] aria-pressed:bg-[var(--overlay-active)] aria-pressed:text-ink">
                    <Icon size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div ref={scrollRef} className="project-portal-scroll ui-scroll-region" data-testid="portal-content">
        <div className="project-portal-content">
          {recent.length === 0 || query.trim() !== '' || filter === 'archived' ? null : (
            <section aria-labelledby="portal-recent-heading" data-testid="portal-recent">
              <h2 id="portal-recent-heading" className="mb-2 text-[length:var(--font-ui-size)] font-medium">最近使用</h2>
              <div className="project-recent-list">
                {recent.map(project => (
                  <button key={project.id} type="button" onClick={() => onOpenProject(project.id)}
                    className="project-recent-row">
                    <span className="min-w-0 flex-1 truncate font-medium">{project.title}</span>
                    <span className="shrink-0 text-muted text-[length:var(--font-meta-size)]">{projectStageLabel(project.currentStage)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section aria-labelledby={all.length > 0 ? 'portal-all-heading' : undefined} className="flex flex-col gap-3">
          {all.length > 0 ?
          <h2 id="portal-all-heading" className="flex items-baseline gap-2 text-[length:var(--font-ui-size)] font-medium">{filter === 'archived' ? '已归档项目' : filter === 'active' ? '进行中的项目' : '全部项目'} <span className="font-normal text-muted tabular-nums text-[length:var(--font-meta-size)]">{shown.length.toLocaleString('zh-CN')} 个</span></h2> : null}

          {projects.list.status === 'error' ? (
            <ErrorBar
              error={{
                level: 'page',
                message: projects.list.error ?? '读取科研项目失败',
                retry: projects.list.reload
              }}
              onDismiss={undefined}
            />
          ) : null}

          {writeError === null ? null : (
            <p role="alert" className="rounded-card border-[0.5px] border-[var(--st-bad-line)] px-3 py-2 text-[var(--st-bad)]" data-testid="portal-write-error">
              {writeError}
            </p>
          )}

          {projects.list.status === 'error' && projects.list.data === null ? null :
          projects.list.status === 'loading' && projects.list.data === null ? (
            <div className="flex items-center gap-2 px-1 py-6 text-muted" role="status">
              <Loader2 size={14} aria-hidden="true" className="animate-spin" />
              正在读取科研项目…
            </div>
          ) : all.length === 0 ? (
            <EmptyState
              title="还没有研究项目"
              description="按研究目标整理文献、任务和写作成果。从上方新建第一个项目。"
              testId="portal-empty"
            />
          ) : shown.length === 0 ? (
            <EmptyState
              title={query.trim().length > 0 ? '没有匹配的项目' : '该状态下没有项目'}
              action={{
                label: query.trim().length > 0 ? '清空搜索' : '查看全部',
                onClick: () => {
                  cancelPinMotion();
                  setQuery('');
                  setFilter('all');
                  resetListFocus();
                }
              }}
              testId="portal-no-match"
            />
          ) : (
            <>
            <div
              ref={listRef}
              role="list"
              aria-label="研究项目"
              onKeyDown={onListKeyDown}
              data-testid="portal-grid"
              data-project-view={projectView}
              className={projectView === 'cards' ? 'project-grid' : 'project-list'}
              style={all.length <= 20 ? { overflowAnchor: 'none' } : undefined}
            >
              {rendered.map((project, index) => (
                <div role="listitem" key={project.id} data-project-index={index} data-project-id={project.id}>
                  <ProjectRow
                    project={project}
                    variant={projectView}
                    pinned={projects.pinnedIds.includes(project.id)}
                    archived={isProjectArchived(project)}
                    focused={index === safeFocusedIndex}
                    showStatus
                    actionsDisabled={busy}
                    onFocus={() => setFocusedId(project.id)}
                    onOpen={() => onOpenProject(project.id)}
                    onTogglePin={() => togglePin(project.id)}
                    onEdit={() => {
                      projects.update.reset();
                      setEditing(project);
                    }}
                    onToggleArchive={() => {
                      projects.update.reset();
                      setArchiving(project);
                    }}
                    onDelete={() => {
                      projects.remove.reset();
                      setDeleting(project);
                    }}
                  />
                </div>
              ))}
            </div>
            {rendered.length >= shown.length ? null : <button type="button" className="self-start rounded-control px-3 py-2 text-muted hover:bg-[var(--overlay-hover)]"
              data-testid="portal-load-more" onClick={() => {
                cancelPinMotion();
                const next = shown[rendered.length];
                if (next === undefined) return;
                pendingFocus.current = next.id;
                setFocusedId(next.id);
                setVisibleLimit(current => current + 40);
              }}>显示更多项目（剩余 {shown.length - rendered.length} 个）</button>}
            </>
          )}
          </section>
        </div>
      </div>

      <ProjectFormDialog
        open={createOpen}
        mode="create"
        pending={projects.create.pending}
        submitError={projects.create.error}
        onCancel={closeCreate}
        onSubmit={(values) => void submitCreate(values)}
        onPickWorkspace={projects.pickWorkspace}
      />

      <ProjectFormDialog
        open={editing !== null}
        mode="edit"
        project={editing}
        pending={projects.update.pending}
        submitError={projects.update.error}
        onCancel={() => setEditing(null)}
        onSubmit={(values) => void submitEdit(values)}
        onPickWorkspace={projects.pickWorkspace}
      />

      <ConfirmDialog
        open={archiving !== null}
        title={archiving !== null && isProjectArchived(archiving) ? '恢复项目？' : '归档项目？'}
        message={
          archiving === null
            ? ''
            : isProjectArchived(archiving)
              ? `「${archiving.title}」将恢复为可写状态。`
              : `「${archiving.title}」归档后进入只读：无法启动阶段运行、无法修改产物、无法写入文件。`
        }
        detail={archiving !== null && isProjectArchived(archiving) ? '恢复后可继续推进阶段。' : '恢复项目即可重新写入。'}
        confirmLabel={archiving !== null && isProjectArchived(archiving) ? '恢复项目' : '归档项目'}
        pending={projects.update.pending}
        error={projects.update.error}
        tone="default"
        testId="portal-archive-confirm"
        onCancel={() => { projects.update.reset(); setArchiving(null); }}
        onConfirm={async () => {
          if (archiving === null) return;
          const result = await projects.update.run({
            id: archiving.id,
            status: isProjectArchived(archiving) ? 'active' : 'archived'
          });
          if (result.ok) setArchiving(null);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除项目记录？"
        message={deleting === null ? '' : `将删除 Roc 中的项目记录「${deleting.title}」。`}
        detail="项目记录无法恢复。磁盘上的工作目录会保留。"
        confirmLabel="删除记录"
        pending={projects.remove.pending}
        error={projects.remove.error}
        tone="destructive"
        testId="portal-delete-confirm"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting === null) return;
          const result = await projects.remove.run(deleting.id);
          if (result.ok) setDeleting(null);
        }}
      />

      {busy ? (
        <span className="sr-only" role="status">
          正在保存
        </span>
      ) : null}
    </div>
  );
}
