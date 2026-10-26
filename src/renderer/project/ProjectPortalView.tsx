import { useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Search } from 'lucide-react';
import type { ResearchProject } from '../../shared/types';
import { ErrorBar } from '../shell/ErrorBar';
import { EmptyState } from '../shell/EmptyState';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { ProjectRow } from './ProjectRow';
import { ProjectFormDialog, type ProjectFormValues } from './ProjectFormDialog';
import { isProjectArchived, visibleProjects, type ProjectStatusFilter } from './project-store';
import { useProjects } from './use-projects';
import type { RocClient } from '../shared/roc-client';

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

export function ProjectPortalView({
  client,
  createFormRequested,
  onRequestConsumed,
  onOpenProject
}: ProjectPortalViewProps): React.JSX.Element {
  const projects = useProjects(client);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectStatusFilter>('active');
  const [createOpen, setCreateOpen] = useState(createFormRequested);
  const [editing, setEditing] = useState<ResearchProject | null>(null);
  const [archiving, setArchiving] = useState<ResearchProject | null>(null);
  const [deleting, setDeleting] = useState<ResearchProject | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Adopt later requests (a second ⌘N after the user closed the form).
  if (createFormRequested && !createOpen) {
    setCreateOpen(true);
  }

  const all = projects.list.data ?? [];
  const shown = useMemo(
    () => visibleProjects(all, { query, filter, pinnedIds: projects.pinnedIds }),
    [all, query, filter, projects.pinnedIds]
  );

  /**
   * Clamped during render, not only inside the key handler.
   *
   * The visible set can shrink underneath the cursor (archiving or deleting under
   * 进行中, or a refresh after an edit). Without this clamp no card would match the
   * stored index, so every project row would be `tabIndex={-1}` and the primary
   * "open project" action would become unreachable by keyboard.
   */
  const safeFocusedIndex = shown.length === 0 ? 0 : Math.min(focusedIndex, shown.length - 1);

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
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    const next = Math.min(Math.max(safeFocusedIndex + delta, 0), shown.length - 1);
    setFocusedIndex(next);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-project-index="${next}"] [data-project-body]`)?.focus();
  };

  const busy = projects.create.pending || projects.update.pending || projects.remove.pending;
  // The create dialog renders its own error inline; showing it again on the
  // portal would be a duplicate message.
  const writeError = projects.update.error ?? projects.remove.error;

  const submitCreate = async (values: ProjectFormValues): Promise<void> => {
    const created = await projects.create.run({
      title: values.title,
      description: values.description,
      workspacePath: values.workspacePath,
      language: values.language
    });
    if (created === null) {
      return;
    }
    closeCreate();
    projects.refresh();
    onOpenProject(created.id);
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
    if (updated === null) {
      return;
    }
    setEditing(null);
    projects.refresh();
  };

  return (
    <div className="h-full overflow-y-auto" data-testid="portal">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="sr-only">研究项目</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-[var(--control-height)] min-w-[220px] flex-1 items-center gap-2 rounded-control border border-line bg-surface px-2.5">
            <Search size={13} aria-hidden="true" className="shrink-0 text-subtle" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setFocusedIndex(0);
              }}
              placeholder="搜索项目"
              aria-label="搜索项目"
              data-testid="portal-search"
              className="min-w-0 flex-1 bg-transparent text-ink placeholder:text-subtle"
            />
            {query.length === 0 ? null : (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded-control px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
              >
                清空
              </button>
            )}
          </div>
          <div role="group" aria-label="项目状态筛选" className="flex items-center gap-0.5">
            {STATUS_FILTERS.map((entry) => {
              const selected = entry.id === filter;
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setFilter(entry.id);
                    setFocusedIndex(0);
                  }}
                  data-testid={`portal-filter-${entry.id}`}
                  className={
                    selected
                      ? 'h-[var(--control-height)] rounded-control bg-accent-soft px-2.5 text-ink active:bg-[var(--accent-soft-strong)]'
                      : 'h-[var(--control-height)] rounded-control px-2.5 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                  }
                >
                  <span className="text-[var(--font-meta-size)]">{entry.label}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            data-testid="portal-new-project"
            aria-label="新建研究项目"
            onClick={() => setCreateOpen(true)}
            className="ml-auto flex h-[var(--control-height)] shrink-0 items-center gap-1.5 rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <Plus size={14} aria-hidden="true" />
            新建项目
          </button>
        </div>

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
          <p role="alert" className="rounded-card border border-[var(--st-bad-line)] px-3 py-2 text-[var(--st-bad)]" data-testid="portal-write-error">
            {writeError}
          </p>
        )}

        {projects.list.status === 'loading' && projects.list.data === null ? (
          <div className="flex items-center gap-2 px-1 py-6 text-muted" role="status">
            <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            正在读取科研项目…
          </div>
        ) : all.length === 0 ? (
          <EmptyState
            title="还没有研究项目"
            action={{ label: '新建项目', onClick: () => setCreateOpen(true) }}
            testId="portal-empty"
          />
        ) : shown.length === 0 ? (
          <EmptyState
            title={query.trim().length > 0 ? '没有匹配的项目' : '该状态下没有项目'}
            action={{
              label: query.trim().length > 0 ? '清空搜索' : '查看全部',
              onClick: () => {
                setQuery('');
                setFilter('all');
              }
            }}
            testId="portal-no-match"
          />
        ) : (
          <div
            ref={listRef}
            role="list"
            aria-label="研究项目"
            onKeyDown={onListKeyDown}
            data-testid="portal-grid"
            className="flex flex-col"
          >
            {shown.map((project, index) => (
              <div role="listitem" key={project.id} data-project-index={index}>
                <ProjectRow
                  project={project}
                  pinned={projects.pinnedIds.includes(project.id)}
                  archived={isProjectArchived(project)}
                  focused={index === safeFocusedIndex}
                  showStatus={filter === 'all' || (project.status !== 'active' && project.status !== 'archived')}
                  onFocus={() => setFocusedIndex(index)}
                  onOpen={() => onOpenProject(project.id)}
                  onTogglePin={() => projects.togglePin(project.id)}
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
        )}
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
        confirmLabel={archiving !== null && isProjectArchived(archiving) ? '恢复' : '归档'}
        tone="default"
        testId="portal-archive-confirm"
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          const target = archiving;
          setArchiving(null);
          if (target === null) {
            return;
          }
          void (async () => {
            const updated = await projects.update.run({
              id: target.id,
              status: isProjectArchived(target) ? 'active' : 'archived'
            });
            if (updated !== null) {
              projects.refresh();
            }
          })();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除项目记录？"
        message={deleting === null ? '' : `将删除 Roc 中的项目记录「${deleting.title}」。`}
        detail="只删除 Roc 中的项目记录，不删除磁盘上的工作目录。此操作不可撤销。"
        confirmLabel="删除记录"
        tone="destructive"
        testId="portal-delete-confirm"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target === null) {
            return;
          }
          void (async () => {
            const removed = await projects.remove.run(target.id);
            if (removed !== null) {
              projects.refresh();
            }
          })();
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
