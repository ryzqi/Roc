import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RocDomainError } from '../../../src/main/services/errors';
import { RocPaths } from '../../../src/main/services/paths';
import { SkillService } from '../../../src/main/services/skill-service';

let root: string;
let paths: RocPaths;
let service: SkillService;

function writeSkill(id: string, files: Record<string, string | Buffer>): void {
  const dir = join(paths.skillsDir, id);
  mkdirSync(dir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(join(dir, 'roc.skill.json'), `${JSON.stringify({ schemaVersion: 1, enabled: true }, null, 2)}\n`, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-skill-files-test-'));
  paths = new RocPaths(root);
  paths.ensureTree();
  service = new SkillService(paths);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('SkillService.listFiles', () => {
  it('returns root entries sorted with directories first', () => {
    writeSkill('alpha', {
      'SKILL.md': '---\nname: alpha\ndescription: alpha skill\n---\n',
      'README.md': 'readme',
      'references/inner.md': 'inner',
      'examples/case.md': 'case'
    });

    const result = service.listFiles({ id: 'alpha', relativePath: '' });

    expect(result.id).toBe('alpha');
    expect(result.relativePath).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => entry.name)).toEqual([
      'examples',
      'references',
      'README.md',
      'roc.skill.json',
      'SKILL.md'
    ]);
    const examples = result.entries.find((entry) => entry.name === 'examples');
    expect(examples?.type).toBe('directory');
    expect(examples?.relativePath).toBe('examples');
  });

  it('lists nested directory entries with forward-slash paths', () => {
    writeSkill('beta', {
      'SKILL.md': '---\nname: beta\ndescription: beta\n---\n',
      'references/sub/file.md': 'deep'
    });

    const result = service.listFiles({ id: 'beta', relativePath: 'references' });

    expect(result.relativePath).toBe('references');
    expect(result.entries.map((entry) => entry.relativePath)).toContain('references/sub');
  });

  it('throws when the skill id is unknown', () => {
    expect(() => service.listFiles({ id: 'missing', relativePath: '' })).toThrowError(RocDomainError);
  });

  it('throws when the target resolves outside the skill root', () => {
    writeSkill('gamma', { 'SKILL.md': '---\nname: gamma\ndescription: g\n---\n' });

    expect(() => service.listFiles({ id: 'gamma', relativePath: '../alpha' })).toThrowError(RocDomainError);
    expect(() => service.listFiles({ id: 'gamma', relativePath: '..' })).toThrowError(RocDomainError);
  });

  it('throws when the target is a file, not a directory', () => {
    writeSkill('delta', { 'SKILL.md': '---\nname: delta\ndescription: d\n---\n' });

    expect(() => service.listFiles({ id: 'delta', relativePath: 'SKILL.md' })).toThrowError(RocDomainError);
  });

  it('ignores .git directories', () => {
    writeSkill('epsilon', {
      'SKILL.md': '---\nname: epsilon\ndescription: e\n---\n',
      '.git/HEAD': 'ref: refs/heads/main'
    });

    const result = service.listFiles({ id: 'epsilon', relativePath: '' });

    expect(result.entries.find((entry) => entry.name === '.git')).toBeUndefined();
  });
});
