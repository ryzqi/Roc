import { Archive, ArchiveRestore, Pencil, Pin, Trash2 } from 'lucide-react';
import type { ResearchProject } from '../../shared/types';
import { formatRelativeBeijing, truncateMiddle } from '../shared/format';
import { projectStageLabel, projectStatusLabel } from './project-store';

/**
 * Project card (P2/T2.2).
 *
 * Shows exactly four fields — title, current stage, status, last update — plus a
 * single truncated line of the research goal. The old frontend's
 * `paperCount` / `fileCount` / `wordCount` are deliberately absent: they were
 * fabricated. Counts are only added if a real lazy call can supply them.
 *
 * Actions are inline icon buttons (not a popover menu) so they are reachable in
 * visual order by keyboard and each carries its own `aria-label`. Archive and
 * delete are destructive-adjacent and live away from the card's primary click
 * target — the card body opens the project, the footer acts on it.
 *
 * The hover lift (`-translate-y-0.5` + `--shadow-card-hover`) is a state signal, not
 * decoration: the grid has no other cue that the whole card — not just its footer — is
 * the click target. Under `prefers-reduced-motion` the translate is switched off
 * rather than sped up, because the global rule in `styles/index.css` collapses
 * transitions to 0.01ms, which would turn a smooth lift into a 2px jump.
 */

export type ProjectCardProps = {
  project: ResearchProject;
  pinned: boolean;
  archived: boolean;
  /** Focused card in the grid's roving focus. */
  focused: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onTogglePin: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
};

export function ProjectCard({
  project,
  pinned,
  archived,
  focused,
  onFocus,
  onOpen,
  onTogglePin,
  onEdit,
  onToggleArchive,
  onDelete
}: ProjectCardProps): React.JSX.Element {
  return (
    <div
      data-testid={`portal-card-${project.id}`}
      data-archived={archived}
      className={
        archived
          ? 'group flex flex-col rounded-card border border-line-soft bg-surface opacity-80'
          : 'group flex flex-col rounded-card border border-line bg-surface transition-all duration-[var(--duration-fast)] hover:-translate-y-0.5 hover:border-accent hover:shadow-[var(--shadow-card-hover)] motion-reduce:hover:translate-y-0'
      }
    >
      <button
        type="button"
        data-card-body="true"
        tabIndex={focused ? 0 : -1}
        onFocus={onFocus}
        onClick={onOpen}
        aria-label={`打开项目 ${project.title}`}
        data-testid={`portal-card-open-${project.id}`}
        className="flex flex-col gap-1.5 rounded-t-card px-4 pb-2.5 pt-4 text-left hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)]"
      >
        <span className="flex items-center gap-1.5">
          {pinned ? (
            <Pin size={12} aria-hidden="true" className="shrink-0 fill-current text-accent" data-testid="portal-card-pinned" />
          ) : null}
          <span className="line-clamp-2 min-w-0 flex-1 text-[var(--font-read-size)] font-medium leading-snug text-ink" title={project.title}>
            {project.title}
          </span>
        </span>

        <span className="truncate text-muted text-[var(--font-meta-size)]" title={project.description}>
          {project.description}
        </span>

        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--font-micro-size)]">
          <span className="rounded-[var(--r-control)] bg-accent-soft px-1.5 py-0.5 text-ink" data-testid="portal-card-stage">
            {projectStageLabel(project.currentStage)}
          </span>
          <span
            className={
              archived ? 'text-[var(--st-warn)]' : 'text-[var(--st-ok)]'
            }
            data-testid="portal-card-status"
          >
            {projectStatusLabel(project.status)}
          </span>
          <span className="text-subtle" data-testid="portal-card-updated">
            {formatRelativeBeijing(project.updatedAt)}
          </span>
        </span>

        {project.workspacePath === null ? (
          <span className="truncate text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="portal-card-no-workspace">
            未绑定工作目录
          </span>
        ) : (
          <span className="truncate font-mono text-subtle text-[var(--font-micro-size)]" title={project.workspacePath}>
            {truncateMiddle(project.workspacePath, 44)}
          </span>
        )}
      </button>

      <div className="flex items-center gap-0.5 border-t border-line-soft px-3 py-2">
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          aria-label={pinned ? `取消置顶 ${project.title}` : `本机置顶 ${project.title}`}
          title={pinned ? '取消置顶' : '置顶'}
          data-testid={`portal-card-pin-${project.id}`}
          className={
            pinned
              ? 'flex h-6 w-6 items-center justify-center rounded-control bg-accent-soft text-accent active:bg-[var(--accent-soft-strong)]'
              : 'flex h-6 w-6 items-center justify-center rounded-control text-subtle hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
          }
        >
          <Pin size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`编辑 ${project.title}`}
          title="编辑"
          data-testid={`portal-card-edit-${project.id}`}
          className="flex h-6 w-6 items-center justify-center rounded-control text-subtle hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onToggleArchive}
          aria-label={archived ? `恢复 ${project.title}` : `归档 ${project.title}`}
          title={archived ? '恢复（恢复后可写）' : '归档（归档后只读）'}
          data-testid={`portal-card-archive-${project.id}`}
          className="flex h-6 w-6 items-center justify-center rounded-control text-subtle hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          {archived ? <ArchiveRestore size={12} aria-hidden="true" /> : <Archive size={12} aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`删除 ${project.title}`}
          title="删除（只删 Roc 记录，不删磁盘目录）"
          data-testid={`portal-card-delete-${project.id}`}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-control text-subtle hover:bg-[var(--overlay-hover)] hover:text-[var(--st-bad)] active:bg-[var(--overlay-active)]"
        >
          <Trash2 size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
