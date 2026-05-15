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

  it('renders filter strip and clickable rows without inline buttons or paths', () => {
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
        selectedSkillId: null,
        onFilterChange: () => {},
        onSelectSkill: () => {},
        drawer: null
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
    expect(html).toContain('class="section skill-management-surface"');
    expect(html).toContain('class="list-rows skill-row-list"');
    expect(html).toContain('missing dependency');

    expect(html).not.toContain('Skill 总数');
    expect(html).not.toContain('F:\\Code\\Roc\\skills\\smoke-skill');
    expect(html).not.toContain('data-testid="skill-toggle-smoke-skill"');
    expect(html).not.toContain('data-testid="skill-delete-smoke-skill"');
    expect(html).not.toContain('data-testid="skill-drawer"');
    expect(html).not.toContain('empty-state');
  });

  it('renders the drawer node when provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillsView, {
        model: buildSkillManagementViewModel(
          [createSkill({ id: 'open-skill', name: 'Open Skill' })],
          'all',
          'open-skill'
        ),
        selectedSkillId: 'open-skill',
        onFilterChange: () => {},
        onSelectSkill: () => {},
        drawer: React.createElement('aside', { 'data-testid': 'skill-drawer' }, 'drawer body')
      })
    );

    expect(html).toContain('data-testid="skill-drawer"');
    expect(html).toContain('drawer body');
    expect(html).toMatch(/skill-row-button selected/);
  });
});
