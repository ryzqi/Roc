import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('stores skills under the configured Roc data root', () => {
    expect(paths.skillsDir).toBe(join(root, 'skills'));
  });

  it('marks skills invalid when the directory name does not match the official skill name', () => {
    writeSkill('alias-review', {
      'SKILL.md': '---\nname: project-review\ndescription: canonical skill name\n---\n'
    });

    expect(service.list()).toContainEqual(
      expect.objectContaining({
        id: 'alias-review',
        name: 'alias-review',
        status: 'invalid'
      })
    );
  });

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

describe('SkillService.readFile', () => {
  it('returns text content for utf-8 files', () => {
    writeSkill('text-skill', {
      'SKILL.md': '---\nname: text-skill\ndescription: t\n---\n# Body'
    });

    const result = service.readFile({ id: 'text-skill', relativePath: 'SKILL.md' });

    expect(result.kind).toBe('text');
    expect(result.content).toContain('# Body');
    expect(result.truncated).toBe(false);
    expect(result.relativePath).toBe('SKILL.md');
  });

  it('truncates text content when over maxBytes', () => {
    writeSkill('long-skill', {
      'SKILL.md': '---\nname: long-skill\ndescription: l\n---\n',
      'big.txt': 'a'.repeat(10_000)
    });

    const result = service.readFile({ id: 'long-skill', relativePath: 'big.txt', maxBytes: 1024 });

    expect(result.kind).toBe('text');
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(1024);
    expect(result.sizeBytes).toBe(10_000);
  });

  it('returns a data URI for image files', () => {
    writeSkill('image-skill', {
      'SKILL.md': '---\nname: image-skill\ndescription: i\n---\n',
      'pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    });

    const result = service.readFile({ id: 'image-skill', relativePath: 'pic.png' });

    expect(result.kind).toBe('image');
    expect(result.mediaType).toBe('image/png');
    expect(result.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('treats files with null bytes as binary', () => {
    writeSkill('binary-skill', {
      'SKILL.md': '---\nname: binary-skill\ndescription: b\n---\n',
      'blob.dat': Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])
    });

    const result = service.readFile({ id: 'binary-skill', relativePath: 'blob.dat' });

    expect(result.kind).toBe('binary');
    expect(result.content).toBe('');
    expect(result.sizeBytes).toBe(5);
  });

  it('throws when target is a directory', () => {
    writeSkill('dir-skill', {
      'SKILL.md': '---\nname: dir-skill\ndescription: d\n---\n',
      'references/file.md': 'inner'
    });

    expect(() => service.readFile({ id: 'dir-skill', relativePath: 'references' })).toThrowError(RocDomainError);
  });

  it('throws when path escapes the skill root', () => {
    writeSkill('escape-skill', { 'SKILL.md': '---\nname: escape-skill\ndescription: e\n---\n' });

    expect(() => service.readFile({ id: 'escape-skill', relativePath: '../alpha/SKILL.md' })).toThrowError(RocDomainError);
  });
});

describe('SkillService.importSkill', () => {
  it('derives the installed skill id from official metadata instead of caller input', () => {
    const source = mkdtempSync(join(tmpdir(), 'roc-skill-import-source-'));
    try {
      writeFileSync(
        join(source, 'SKILL.md'),
        '---\nname: imported-review\ndescription: imported skill\n---\n',
        'utf8'
      );

      const imported = service.importSkill({ sourcePath: source } as never);

      expect(imported.id).toBe('imported-review');
      expect(imported.path).toBe(join(paths.skillsDir, 'imported-review'));
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('imports a skill containing official metadata fields without widening SkillSnapshot', () => {
    const source = mkdtempSync(join(tmpdir(), 'roc-skill-import-metadata-'));
    try {
      writeFileSync(
        join(source, 'SKILL.md'),
        [
          '---',
          'name: metadata-review',
          'description: imported skill',
          'allowed-tools: read_file write_file',
          'module: index.ts',
          'license: MIT',
          'compatibility: Roc desktop only',
          'metadata:',
          '  owner: test',
          '  tier: internal',
          '---',
          '# Metadata Review'
        ].join('\n'),
        'utf8'
      );

      const imported = service.importSkill({ sourcePath: source } as never);

      expect(imported).toEqual({
        id: 'metadata-review',
        name: 'metadata-review',
        enabled: true,
        path: join(paths.skillsDir, 'metadata-review'),
        description: 'imported skill',
        status: 'ready',
        lastError: null
      });
      expect(imported).not.toHaveProperty('allowedTools');
      expect(imported).not.toHaveProperty('module');
      expect(imported).not.toHaveProperty('license');
      expect(imported).not.toHaveProperty('compatibility');
      expect(imported).not.toHaveProperty('metadata');
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('rejects invalid frontmatter through the official parser', () => {
    const source = mkdtempSync(join(tmpdir(), 'roc-skill-import-invalid-'));
    try {
      writeFileSync(
        join(source, 'SKILL.md'),
        ['---', 'name: Invalid Name', 'description: invalid skill', '---'].join('\n'),
        'utf8'
      );

      expect(() => service.importSkill({ sourcePath: source } as never)).toThrowError(RocDomainError);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});
