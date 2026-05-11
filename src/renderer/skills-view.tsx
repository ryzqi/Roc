import type React from 'react';
import type { SkillSnapshot } from '../shared/types';

export type SkillFilterId = 'all' | 'enabled' | 'disabled' | 'invalid';

type SkillViewRow = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  status: SkillSnapshot['status'];
  lastError: string | null;
  statusTone: 'ok' | 'warn';
  statusLabel: string;
  actionLabel: '启用' | '禁用';
};

type SkillSummary = {
  total: number;
  enabled: number;
  ready: number;
  invalid: number;
};

type SkillEmptyState = {
  title: string;
  detail: string;
};

export type SkillManagementViewModel = {
  filter: SkillFilterId;
  filters: Array<{
    id: SkillFilterId;
    label: string;
    count: number;
  }>;
  summary: SkillSummary;
  visibleSkills: SkillViewRow[];
  emptyState: SkillEmptyState | null;
};

type SkillsViewProps = {
  model: SkillManagementViewModel;
  busySkillId: string | null;
  onDeleteSkill: (skillId: string) => void | Promise<void>;
  onFilterChange: (filter: SkillFilterId) => void;
  onToggleSkill: (skillId: string, enabled: boolean) => void | Promise<void>;
};

function mapSkillRow(skill: SkillSnapshot): SkillViewRow {
  const statusLabel = skill.status === 'invalid' ? 'invalid' : skill.enabled ? 'ready' : 'disabled';
  return {
    id: skill.id,
    name: skill.name,
    path: skill.path,
    enabled: skill.enabled,
    status: skill.status,
    lastError: skill.lastError ?? null,
    statusTone: skill.enabled && skill.status === 'ready' ? 'ok' : 'warn',
    statusLabel,
    actionLabel: skill.enabled ? '禁用' : '启用'
  };
}

function filterSkill(row: SkillViewRow, filter: SkillFilterId): boolean {
  switch (filter) {
    case 'enabled':
      return row.enabled;
    case 'disabled':
      return !row.enabled;
    case 'invalid':
      return row.status === 'invalid';
    case 'all':
    default:
      return true;
  }
}

function buildEmptyState(skills: SkillSnapshot[], filter: SkillFilterId): SkillEmptyState | null {
  if (skills.length === 0) {
    return {
      title: '还没有导入 Skill',
      detail: '当前列表为空。先导入本地 Skill，再在这里管理启用状态。'
    };
  }
  switch (filter) {
    case 'enabled':
      return {
        title: '没有已启用 Skill',
        detail: '当前没有命中已启用筛选的项。可以切到其他视图继续浏览。'
      };
    case 'disabled':
      return {
        title: '没有已禁用 Skill',
        detail: '当前所有 Skill 都处于启用状态。'
      };
    case 'invalid':
      return {
        title: '没有失效 Skill',
        detail: '当前没有需要修复依赖或描述的 Skill。'
      };
    case 'all':
    default:
      return {
        title: '没有可显示的 Skill',
        detail: '当前筛选结果为空。'
      };
  }
}

export function buildSkillManagementViewModel(
  skills: SkillSnapshot[],
  filter: SkillFilterId,
  _selectedSkillId: string | null
): SkillManagementViewModel {
  const rows = skills.map(mapSkillRow);
  const visibleSkills = rows.filter((row) => filterSkill(row, filter));
  const summary: SkillSummary = {
    total: skills.length,
    enabled: skills.filter((skill) => skill.enabled).length,
    ready: skills.filter((skill) => skill.enabled && skill.status === 'ready').length,
    invalid: skills.filter((skill) => skill.status === 'invalid').length
  };

  return {
    filter,
    filters: [
      { id: 'all', label: '全部', count: skills.length },
      { id: 'enabled', label: '已启用', count: skills.filter((skill) => skill.enabled).length },
      { id: 'disabled', label: '已禁用', count: skills.filter((skill) => !skill.enabled).length },
      { id: 'invalid', label: '失效', count: skills.filter((skill) => skill.status === 'invalid').length }
    ],
    summary,
    visibleSkills,
    emptyState: visibleSkills.length === 0 ? buildEmptyState(skills, filter) : null
  };
}

function SummaryMetric({
  label,
  note,
  tone = 'neutral',
  value
}: {
  label: string;
  note: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad';
  value: number | string;
}): React.JSX.Element {
  const toneClass = tone === 'neutral' ? '' : ` metric--${tone}`;
  return (
    <div className={`metric${toneClass}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{note}</small>
    </div>
  );
}

function EmptyCard({ detail, title, testId }: { detail: string; title: string; testId: string }): React.JSX.Element {
  return (
    <div className="empty-state" data-testid={testId}>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function StatusPill({
  tone,
  value
}: {
  tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
  value: string;
}): React.JSX.Element {
  return <span className={`pill ${tone}`}>{value}</span>;
}

function SelectionChip({
  active,
  count,
  id,
  label,
  onClick
}: {
  active: boolean;
  count: number;
  id: SkillFilterId;
  label: string;
  onClick: (id: SkillFilterId) => void;
}): React.JSX.Element {
  return (
    <button
      className={active ? 'selection-chip active' : 'selection-chip'}
      data-testid={`skills-filter-${id}`}
      type="button"
      onClick={() => onClick(id)}
    >
      <span>{label}</span>
      <strong>{count}</strong>
    </button>
  );
}

export function SkillsView({
  model,
  busySkillId,
  onDeleteSkill,
  onFilterChange,
  onToggleSkill
}: SkillsViewProps): React.JSX.Element {
  return (
    <section className="canvas-stage stage-grid" data-testid="skills-view">
      <div className="grid-3">
        <SummaryMetric label="Skill 总数" note={`${model.summary.enabled} 个已启用`} value={model.summary.total} />
        <SummaryMetric label="Ready" note="可被本轮选择" tone="ok" value={model.summary.ready} />
        <SummaryMetric label="Invalid" note="需要修复依赖或描述" tone="warn" value={model.summary.invalid} />
      </div>
      <section className="card" data-testid="skill-management">
        <div className="card-title">Skill 管理</div>
        <div className="skills-filter-strip">
          {model.filters.map((filter) => (
            <SelectionChip
              active={model.filter === filter.id}
              count={filter.count}
              id={filter.id}
              key={filter.id}
              label={filter.label}
              onClick={onFilterChange}
            />
          ))}
        </div>
        {model.emptyState === null ? (
          model.visibleSkills.map((skill) => {
            const busy = busySkillId === skill.id;
            return (
              <div className="row action-row" data-testid={`skill-row-${skill.id}`} key={skill.id}>
                <div>
                  <div className="row-title">{skill.name}</div>
                  <div className="row-sub">{skill.path}</div>
                  {skill.lastError === null ? null : (
                    <div className="row-sub skills-row-error">{skill.lastError}</div>
                  )}
                </div>
                <StatusPill tone={skill.statusTone} value={skill.statusLabel} />
                <button
                  data-testid={`skill-toggle-${skill.id}`}
                  disabled={busy}
                  type="button"
                  onClick={() => onToggleSkill(skill.id, !skill.enabled)}
                >
                  {skill.actionLabel}
                </button>
                <button
                  data-testid={`skill-delete-${skill.id}`}
                  disabled={busy}
                  type="button"
                  onClick={() => onDeleteSkill(skill.id)}
                >
                  删除
                </button>
              </div>
            );
          })
        ) : (
          <EmptyCard detail={model.emptyState.detail} testId="skills-empty-state" title={model.emptyState.title} />
        )}
      </section>
    </section>
  );
}
