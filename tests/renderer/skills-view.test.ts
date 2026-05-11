import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SkillSnapshot } from '../../src/shared/types';
import { SkillsView, buildSkillManagementViewModel } from '../../src/renderer/skills-view';

function createSkill(overrides: Partial<SkillSnapshot> & Pick<SkillSnapshot, 'id' | 'name'>): SkillSnapshot {
  return {
    enabled: true,
    path: `F:\\Code\\Roc\\skills\\${overrides.id}`,
    description: `${overrides.name} 描述`,
    status: 'ready',
    lastError: null,
    ...overrides
  };
}

describe('skills view', () => {
  it('builds enabled and invalid filters with consistent summary counts', () => {
    const skills = [
      createSkill({ id: 'enabled-ready', name: 'Enabled Ready' }),
      createSkill({ id: 'disabled-ready', name: 'Disabled Ready', enabled: false }),
      createSkill({
        id: 'broken-skill',
        name: 'Broken Skill',
        description: '需要修复依赖。',
        status: 'invalid',
        lastError: 'missing dependency'
      }),
      createSkill({
        id: 'disabled-invalid',
        name: 'Disabled Invalid',
        enabled: false,
        description: '已禁用但仍然失效。',
        status: 'invalid',
        lastError: 'still broken'
      })
    ];

    const enabledModel = buildSkillManagementViewModel(skills, 'enabled', null);
    expect(enabledModel.summary.total).toBe(4);
    expect(enabledModel.summary.enabled).toBe(2);
    expect(enabledModel.summary.ready).toBe(1);
    expect(enabledModel.summary.invalid).toBe(2);
    expect(enabledModel.visibleSkills.map((skill) => skill.id)).toEqual(['enabled-ready', 'broken-skill']);
    expect(enabledModel.emptyState).toBeNull();

    const invalidModel = buildSkillManagementViewModel(skills, 'invalid', null);
    expect(invalidModel.visibleSkills.map((skill) => skill.id)).toEqual(['broken-skill', 'disabled-invalid']);
    expect(invalidModel.emptyState).toBeNull();
    expect(invalidModel.visibleSkills[1]?.statusLabel).toBe('invalid');

    const disabledModel = buildSkillManagementViewModel(skills, 'disabled', null);
    expect(disabledModel.visibleSkills.map((skill) => skill.id)).toEqual(['disabled-ready', 'disabled-invalid']);
  });

  it('renders filter controls and condensed list rows aligned with the control surface', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillsView, {
        model: buildSkillManagementViewModel(
          [
            createSkill({
              id: 'smoke-skill',
              name: 'Smoke Skill',
              description: '用于 smoke 的技能说明。',
              path: 'F:\\Code\\Roc\\skills\\smoke-skill'
            }),
            createSkill({
              id: 'broken-skill',
              name: 'Broken Skill',
              description: '失效技能说明。',
              status: 'invalid',
              lastError: 'missing dependency'
            })
          ],
          'all',
          null
        ),
        busySkillId: null,
        onDeleteSkill: async () => {},
        onFilterChange: () => {},
        onToggleSkill: async () => {}
      })
    );

    expect(html).toContain('data-testid="skills-view"');
    expect(html).toContain('data-testid="skills-filter-all"');
    expect(html).toContain('data-testid="skills-filter-enabled"');
    expect(html).toContain('data-testid="skills-filter-disabled"');
    expect(html).toContain('data-testid="skills-filter-invalid"');
    expect(html).toContain('data-testid="skill-management"');
    expect(html).toContain('data-testid="skill-row-smoke-skill"');
    expect(html).toContain('data-testid="skill-row-broken-skill"');
    expect(html).toContain('data-testid="skill-toggle-smoke-skill"');
    expect(html).toContain('data-testid="skill-delete-smoke-skill"');
    expect(html).toContain('F:\\Code\\Roc\\skills\\smoke-skill');
    expect(html).toContain('missing dependency');
    expect(html).not.toContain('data-testid="skill-detail"');
    expect(html).not.toContain('用于 smoke 的技能说明。');
    expect(html).not.toContain('失效技能说明。');
    expect(html).not.toContain('按状态筛选并直接执行启停或删除');
    expect(html).not.toContain('完整元信息移动到右侧详情区');
  });
});
