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
  it('builds enabled and invalid filters while keeping the selected detail in sync', () => {
    const skills = [
      createSkill({ id: 'enabled-ready', name: 'Enabled Ready' }),
      createSkill({ id: 'disabled-ready', name: 'Disabled Ready', enabled: false }),
      createSkill({
        id: 'broken-skill',
        name: 'Broken Skill',
        description: '需要修复依赖。',
        status: 'invalid',
        lastError: 'missing dependency'
      })
    ];

    const enabledModel = buildSkillManagementViewModel(skills, 'enabled', null);
    expect(enabledModel.summary.total).toBe(3);
    expect(enabledModel.summary.enabled).toBe(2);
    expect(enabledModel.summary.ready).toBe(2);
    expect(enabledModel.summary.invalid).toBe(1);
    expect(enabledModel.visibleSkills.map((skill) => skill.id)).toEqual(['enabled-ready', 'broken-skill']);
    expect(enabledModel.selectedSkill?.id).toBe('enabled-ready');

    const invalidModel = buildSkillManagementViewModel(skills, 'invalid', 'enabled-ready');
    expect(invalidModel.visibleSkills.map((skill) => skill.id)).toEqual(['broken-skill']);
    expect(invalidModel.selectedSkill?.id).toBe('broken-skill');
    expect(invalidModel.emptyState).toBeNull();

    const disabledModel = buildSkillManagementViewModel(skills, 'disabled', null);
    expect(disabledModel.visibleSkills.map((skill) => skill.id)).toEqual(['disabled-ready']);
  });

  it('renders filter controls, condensed list items, and a separate detail panel', () => {
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
          'broken-skill'
        ),
        busySkillId: null,
        onDeleteSkill: async () => {},
        onFilterChange: () => {},
        onSelectSkill: () => {},
        onToggleSkill: async () => {}
      })
    );

    expect(html).toContain('data-testid="skills-view"');
    expect(html).toContain('data-testid="skills-filter-all"');
    expect(html).toContain('data-testid="skills-filter-enabled"');
    expect(html).toContain('data-testid="skills-filter-disabled"');
    expect(html).toContain('data-testid="skills-filter-invalid"');
    expect(html).toContain('data-testid="skill-management"');
    expect(html).toContain('data-testid="skill-detail"');
    expect(html).toContain('data-testid="skill-detail-path"');
    expect(html).toContain('data-testid="skill-detail-error"');
    expect(html).toContain('用于 smoke 的技能说明。');
    expect(html).toContain('失效技能说明。');
    expect(html).toContain('missing dependency');
    expect(html).toContain('data-testid="skill-toggle-smoke-skill"');
    expect(html).toContain('data-testid="skill-delete-smoke-skill"');
    expect(html).not.toContain('触发与依赖');
  });
});
