import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createSkillsPlugin } from '../../../../src/main/plugins/skills';
import type { SkillImportRequest, SkillSnapshot } from '../../../../src/shared/types';

const skillCapabilities = [
  'skills.list',
  'skills.import',
  'skills.setEnabled',
  'skills.delete',
  'skills.files.list',
  'skills.file.read'
];

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-skills-plugin-test-'));
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('skills plugin', () => {
  it('declares the Phase 3 skills plugin contract', () => {
    const plugin = createSkillsPlugin({ rootDir: root });

    expect(plugin.manifest.id).toBe('@roc/plugin-skills');
    expect(plugin.manifest.dependencies).toEqual([]);
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.required).toBe(true);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(skillCapabilities);
  });

  it('preserves current skill import, list, enablement, delete, and file preview behavior', async () => {
    const capabilities = await initializePlugin();
    const sourceRoot = mkdtempSync(join(tmpdir(), 'roc-skill-plugin-source-'));
    const source = join(sourceRoot, 'project-review');
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, 'SKILL.md'),
        '---\nname: project-review\ndescription: review project changes\n---\n# Project Review',
        'utf8'
      );

      const imported = await capabilities.invoke<SkillImportRequest, SkillSnapshot>('skills.import', { sourcePath: source });
      mkdirSync(join(imported.path, 'references'), { recursive: true });
      writeFileSync(join(imported.path, 'references', 'guide.md'), 'Use concise findings.\n', 'utf8');
      const disabled = await capabilities.invoke<{ id: string; enabled: boolean }, SkillSnapshot>('skills.setEnabled', {
        id: imported.id,
        enabled: false
      });
      const files = await capabilities.invoke('skills.files.list', { id: imported.id, relativePath: '' });
      const preview = await capabilities.invoke('skills.file.read', { id: imported.id, relativePath: 'SKILL.md' });
      const listed = await capabilities.invoke('skills.list', {});
      const deleted = await capabilities.invoke('skills.delete', { id: imported.id });

      expect(imported).toMatchObject({
        id: 'project-review',
        enabled: true,
        status: 'ready',
        description: 'review project changes'
      });
      expect(disabled.enabled).toBe(false);
      expect(files).toMatchObject({
        id: 'project-review',
        entries: expect.arrayContaining([
          expect.objectContaining({
            name: 'references',
            relativePath: 'references',
            type: 'directory'
          })
        ])
      });
      expect(preview).toMatchObject({
        id: 'project-review',
        relativePath: 'SKILL.md',
        kind: 'text',
        content: expect.stringContaining('# Project Review')
      });
      expect(listed).toContainEqual(expect.objectContaining({ id: 'project-review', enabled: false }));
      expect(deleted).toEqual({ deleted: true });
      await expect(capabilities.invoke('skills.list', {})).resolves.toEqual([]);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('returns the current invalid metadata error shape through capabilities', async () => {
    const capabilities = await initializePlugin();
    const source = mkdtempSync(join(tmpdir(), 'roc-skill-plugin-invalid-'));
    try {
      writeFileSync(
        join(source, 'SKILL.md'),
        ['---', 'name: Invalid Name', 'description: invalid skill', '---'].join('\n'),
        'utf8'
      );

      await expect(capabilities.invoke('skills.import', { sourcePath: source })).rejects.toMatchObject({
        code: 'skill_invalid',
        message: 'SKILL.md 不符合 Deep Agents Skill 规范。',
        category: 'validation',
        retryable: false,
        userAction: '请修复 SKILL.md frontmatter 后重试。'
      });
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

async function initializePlugin(): Promise<CapabilityRegistry> {
  const plugin = createSkillsPlugin({ rootDir: root });
  const capabilities = new CapabilityRegistry();
  for (const descriptor of plugin.manifest.capabilities) {
    capabilities.declare(plugin.manifest.id, descriptor);
  }
  await plugin.initialize(createContext(capabilities));
  return capabilities;
}

function createContext(capabilities: CapabilityRegistry): RocPluginContext {
  return {
    pluginId: '@roc/plugin-skills',
    eventBus: createEventBus(),
    capabilities,
    database: { getConnection: () => db, getCoreConnection: () => db },
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

function createEventBus(): RocEventBus {
  return {
    publish: async () => {},
    subscribe: () => () => {}
  };
}
