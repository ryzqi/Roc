import { Archive, ArchiveRestore, Folder, Pencil, Pin, Trash2 } from 'lucide-react';
import { formatBeijingDateTime } from '../shared/format';
import type { ResearchProject } from '../../shared/types';
import { projectStageLabel, projectStatusLabel } from './project-store';

export type ProjectRowProps = {
  project: ResearchProject;
  variant?: 'cards' | 'list';
  pinned: boolean;
  archived: boolean;
  focused: boolean;
  showStatus: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onTogglePin: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  actionsDisabled?: boolean;
};

const ROW_ACTION =
  'flex h-7 w-7 items-center justify-center rounded-control text-subtle hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50';

export function ProjectRow({
  project,
  variant = 'list',
  pinned,
  archived,
  focused,
  showStatus,
  onFocus,
  onOpen,
  onTogglePin,
  onEdit,
  onToggleArchive,
  onDelete,
  actionsDisabled = false
}: ProjectRowProps): React.JSX.Element {
  const workspaceName =
    project.workspacePath === null
      ? null
      : project.workspacePath.split('/').filter(Boolean).pop() ?? project.workspacePath;
  const statusTone =
    project.status === 'paused' || project.status === 'archived'
      ? 'text-[var(--st-warn)]'
      : project.status === 'active'
        ? 'text-[var(--st-ok)]'
        : 'text-muted';

  return (
    <div
      data-testid={`portal-card-${project.id}`}
      data-archived={archived}
      className={`${variant === 'cards' ? 'flex h-full min-w-0 flex-col items-stretch gap-2 rounded-card border-[0.5px] border-line p-3' : 'flex min-w-0 items-center gap-2 border-b-[0.5px] border-line-soft px-1 py-[var(--control-pad-y)] min-h-[var(--list-row-height)]'} ${archived ? 'opacity-70' : ''}`}
    >
      <button
        type="button"
        data-project-body="true"
        tabIndex={focused ? 0 : -1}
        onFocus={onFocus}
        onClick={onOpen}
        aria-label={`打开项目 ${project.title}`}
        data-testid={`portal-card-open-${project.id}`}
        className="flex min-w-0 flex-1 items-center rounded-control px-2 py-2 text-left hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {pinned ? (
              <Pin size={12} aria-hidden="true" className="shrink-0 fill-current text-accent" data-testid="portal-card-pinned" />
            ) : null}
            <span className="truncate text-[var(--font-ui-size)] font-medium leading-snug text-ink" title={project.title}>
              {project.title}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[var(--font-meta-size)]">
            <span className="text-muted" data-testid="portal-card-stage">
              {projectStageLabel(project.currentStage)}
            </span>
            {showStatus ? (
              <span className={statusTone} data-testid="portal-card-status">
                {projectStatusLabel(project.status)}
              </span>
            ) : null}

            {variant === 'list' ? (
            <span
              className={`inline-flex min-w-0 items-center gap-1 ${workspaceName === null ? 'text-[var(--st-warn)]' : 'text-subtle'}`}
              title={project.workspacePath ?? '未绑定工作目录'}
            >
              <Folder size={12} aria-hidden="true" className="shrink-0 text-[var(--icon-file)]" />
              <span className="truncate" data-testid="portal-card-workspace">
                {workspaceName ?? '未绑定目录'}
              </span>
            </span>
            ) : null}
          </span>
          <time dateTime={project.updatedAt} className="text-subtle text-[var(--font-meta-size)]">更新于 {formatBeijingDateTime(project.updatedAt)}</time>
        </span>
      </button>

      <div className="flex shrink-0 items-center justify-end gap-0.5">
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          aria-label={pinned ? `取消置顶 ${project.title}` : `本机置顶 ${project.title}`}
          title={pinned ? '取消置顶' : '本机置顶'}
          data-testid={`portal-card-pin-${project.id}`}
          className={pinned ? `${ROW_ACTION} bg-accent-soft text-accent` : ROW_ACTION}
        >
          <Pin size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={actionsDisabled}
          aria-label={`编辑 ${project.title}`}
          title="编辑"
          data-testid={`portal-card-edit-${project.id}`}
          className={ROW_ACTION}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onToggleArchive}
          disabled={actionsDisabled}
          aria-label={archived ? `恢复 ${project.title}` : `归档 ${project.title}`}
          title={archived ? '恢复' : '归档'}
          data-testid={`portal-card-archive-${project.id}`}
          className={ROW_ACTION}
        >
          {archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={actionsDisabled}
          aria-label={`删除 ${project.title}`}
          title="删除"
          data-testid={`portal-card-delete-${project.id}`}
          className="flex h-7 w-7 items-center justify-center rounded-control text-subtle hover:bg-[var(--overlay-hover)] hover:text-[var(--st-bad)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
