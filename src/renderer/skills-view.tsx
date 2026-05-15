import type React from 'react';
import type { SkillSnapshot } from '../shared/types';

export type SkillFilterId = 'all' | 'enabled' | 'disabled' | 'invalid';

type SkillViewRow = {
  id: string;
  name: string;
  enabled: boolean;
  status: SkillSnapshot['status'];
  lastError: string | null;
  statusTone: 'ok' | 'warn';
  statusLabel: string;
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
  selectedSkillId: string | null;
  onFilterChange: (filter: SkillFilterId) => void;
  onSelectSkill: (skillId: string) => void;
  drawer: React.ReactNode | null;
};

function mapSkillRow(skill: SkillSnapshot): SkillViewRow {
  const statusLabel = skill.status === 'invalid' ? 'invalid' : skill.enabled ? 'ready' : 'disabled';
  return {
    id: skill.id,
    name: skill.name,
    enabled: skill.enabled,
    status: skill.status,
    lastError: skill.lastError ?? null,
    statusTone: skill.enabled && skill.status === 'ready' ? 'ok' : 'warn',
    statusLabel
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

function EmptyCard({ detail, title, testId }: { detail: string; title: string; testId: string }): React.JSX.Element {
  return (
    <div className="section-empty-state" data-testid={testId}>
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
  selectedSkillId,
  onFilterChange,
  onSelectSkill,
  drawer
}: SkillsViewProps): React.JSX.Element {
  return (
    <section className="canvas-stage stage-grid skill-drawer-host" data-testid="skills-view">
      <section className="section skill-management-surface" data-testid="skill-management">
        <div className="section-head">
          <h2 className="section-title">Skill 管理</h2>
        </div>
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
      </section>
      <div className="list-rows skill-row-list">
        {model.emptyState === null
          ? model.visibleSkills.map((skill) => {
              const isSelected = selectedSkillId === skill.id;
              return (
                <button
                  className={isSelected ? 'skill-row-button selected' : 'skill-row-button'}
                  data-testid={`skill-row-${skill.id}`}
                  key={skill.id}
                  type="button"
                  onClick={() => onSelectSkill(skill.id)}
                >
                  <span className="skill-row-info">
                    <span className="skill-row-name">{skill.name}</span>
                    {skill.lastError === null ? null : (
                      <span className="skill-row-error">{skill.lastError}</span>
                    )}
                  </span>
                  <StatusPill tone={skill.statusTone} value={skill.statusLabel} />
                </button>
              );
            })
          : (
              <EmptyCard detail={model.emptyState.detail} testId="skills-empty-state" title={model.emptyState.title} />
            )}
      </div>
      {drawer}
    </section>
  );
}
