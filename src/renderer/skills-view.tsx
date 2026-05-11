import type React from 'react';
import type { SkillSnapshot } from '../shared/types';

export type SkillFilterId = 'all' | 'enabled' | 'disabled' | 'invalid';

type SkillViewRow = {
  id: string;
  name: string;
  description: string;
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
  selectedSkill: SkillViewRow | null;
  emptyState: SkillEmptyState | null;
};

type SkillsViewProps = {
  model: SkillManagementViewModel;
  busySkillId: string | null;
  onDeleteSkill: (skillId: string) => void | Promise<void>;
  onFilterChange: (filter: SkillFilterId) => void;
  onSelectSkill: (skillId: string) => void;
  onToggleSkill: (skillId: string, enabled: boolean) => void | Promise<void>;
};

function mapSkillRow(skill: SkillSnapshot): SkillViewRow {
  const statusLabel = skill.status === 'invalid' ? 'invalid' : skill.enabled ? 'ready' : 'disabled';
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
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

function selectSkillByFilter(visibleSkills: SkillViewRow[], selectedSkillId: string | null): SkillViewRow | null {
  if (visibleSkills.length === 0) {
    return null;
  }
  if (selectedSkillId === null) {
    return visibleSkills[0];
  }
  return visibleSkills.find((skill) => skill.id === selectedSkillId) ?? visibleSkills[0];
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
  selectedSkillId: string | null
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
    selectedSkill: selectSkillByFilter(visibleSkills, selectedSkillId),
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
  onSelectSkill,
  onToggleSkill
}: SkillsViewProps): React.JSX.Element {
  return (
    <section className="canvas-stage stage-grid" data-testid="skills-view">
      <div className="grid-3">
        <SummaryMetric label="Skill 总数" note={`${model.summary.enabled} 个已启用`} value={model.summary.total} />
        <SummaryMetric label="Ready" note="可被本轮选择" tone="ok" value={model.summary.ready} />
        <SummaryMetric label="Invalid" note="需要修复依赖或描述" tone="warn" value={model.summary.invalid} />
      </div>
      <div className="skills-layout">
        <section className="card card--accent" data-testid="skill-management">
          <div className="card-title">Skill 管理</div>
          <div className="skills-toolbar">
            <div className="skills-toolbar-copy">
              <strong>按状态筛选并直接执行启停或删除。</strong>
              <p>主列表只保留管理所需信息，完整元信息移动到右侧详情区。</p>
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
          </div>
          {model.emptyState === null ? (
            <div className="skills-list" data-testid="skills-list">
              {model.visibleSkills.map((skill) => {
                const active = model.selectedSkill?.id === skill.id;
                const busy = busySkillId === skill.id;
                return (
                  <div
                    className={active ? 'skills-row skills-row--active' : 'skills-row'}
                    data-testid={`skill-row-${skill.id}`}
                    key={skill.id}
                  >
                    <button
                      className="skills-row-copy"
                      data-testid={`skill-select-${skill.id}`}
                      type="button"
                      onClick={() => onSelectSkill(skill.id)}
                    >
                      <div className="skills-row-head">
                        <span className="row-title">{skill.name}</span>
                        <StatusPill tone={skill.statusTone} value={skill.statusLabel} />
                      </div>
                      <div className="row-sub">{skill.description}</div>
                    </button>
                    <div className="skills-row-actions">
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
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyCard
              detail={model.emptyState.detail}
              testId="skills-empty-state"
              title={model.emptyState.title}
            />
          )}
        </section>

        <section className="card skills-detail-card" data-testid="skill-detail">
          <div className="card-title">当前选中 Skill</div>
          {model.selectedSkill === null ? (
            <EmptyCard
              detail="切换筛选或选择左侧列表项后，这里会显示完整说明、路径和错误信息。"
              testId="skill-detail-empty"
              title="没有可展示的 Skill 详情"
            />
          ) : (
            <div className="skills-detail-stack">
              <div className="skills-detail-copy">
                <div className="row-title">{model.selectedSkill.name}</div>
                <p data-testid="skill-detail-description">{model.selectedSkill.description}</p>
              </div>
              <div className="skills-detail-fields">
                <div className="skills-detail-field">
                  <span className="skills-detail-label">ID</span>
                  <code data-testid="skill-detail-id">{model.selectedSkill.id}</code>
                </div>
                <div className="skills-detail-field">
                  <span className="skills-detail-label">路径</span>
                  <code data-testid="skill-detail-path">{model.selectedSkill.path}</code>
                </div>
                <div className="skills-detail-field">
                  <span className="skills-detail-label">状态</span>
                  <div className="skills-detail-pills">
                    <StatusPill tone={model.selectedSkill.statusTone} value={model.selectedSkill.statusLabel} />
                    <StatusPill tone={model.selectedSkill.enabled ? 'ok' : 'warn'} value={model.selectedSkill.enabled ? 'enabled' : 'disabled'} />
                  </div>
                </div>
                {model.selectedSkill.lastError === null ? null : (
                  <div className="skills-detail-field">
                    <span className="skills-detail-label">错误</span>
                    <code data-testid="skill-detail-error">{model.selectedSkill.lastError}</code>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
