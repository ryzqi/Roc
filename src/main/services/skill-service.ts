import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type {
  SkillFileEntry,
  SkillFileTreeRequest,
  SkillFileTreeResult,
  SkillImportRequest,
  SkillSnapshot
} from '../../shared/types';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';

type SkillState = {
  schemaVersion: 1;
  enabled: boolean;
};

const defaultSkillState: SkillState = {
  schemaVersion: 1,
  enabled: true
};

const skillListLimit = 200;
const skillIgnoredDirectories = new Set(['.git']);

export class SkillService {
  constructor(private readonly paths: RocPaths) {}

  list(): SkillSnapshot[] {
    if (!existsSync(this.paths.skillsDir)) {
      return [];
    }

    return readdirSync(this.paths.skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readSkill(entry.name))
      .filter((entry): entry is SkillSnapshot => entry !== null);
  }

  importSkill(request: SkillImportRequest): SkillSnapshot {
    const sourcePath = this.requireText(request.sourcePath, 'skill_source_empty', 'Skill sourcePath 不能为空。', '请选择本地 Skill 目录。');
    const id = this.normalizeSkillId(request.id);
    const sourceRoot = resolve(sourcePath);
    const sourceSkillFile = join(sourceRoot, 'SKILL.md');
    if (!existsSync(sourceSkillFile)) {
      throw new RocDomainError({
        code: 'skill_file_missing',
        message: 'Skill 目录缺少 SKILL.md。',
        category: 'validation',
        retryable: false,
        userAction: '请选择包含 SKILL.md 的 Skill 目录。'
      });
    }
    const targetRoot = join(this.paths.skillsDir, id);
    if (resolve(targetRoot) !== sourceRoot) {
      rmSync(targetRoot, { recursive: true, force: true });
      mkdirSync(targetRoot, { recursive: true });
      for (const entry of readdirSync(sourceRoot)) {
        cpSync(join(sourceRoot, entry), join(targetRoot, entry), { recursive: true });
      }
    }
    this.writeState(id, defaultSkillState);
    const imported = this.readSkill(id);
    if (imported === null) {
      throw new RocDomainError({
        code: 'skill_import_failed',
        message: 'Skill 导入后无法读取。',
        category: 'internal',
        retryable: false,
        userAction: '请检查 Skill 目录权限后重试。'
      });
    }
    return imported;
  }

  setEnabled(id: string, enabled: boolean): SkillSnapshot {
    const skillId = this.normalizeSkillId(id);
    const skill = this.readSkill(skillId);
    if (skill === null) {
      throw this.notFound(skillId);
    }
    this.writeState(skillId, {
      schemaVersion: 1,
      enabled
    });
    const updated = this.readSkill(skillId);
    if (updated === null) {
      throw this.notFound(skillId);
    }
    return updated;
  }

  deleteSkill(id: string): void {
    const skillId = this.normalizeSkillId(id);
    const skillPath = join(this.paths.skillsDir, skillId);
    if (!existsSync(skillPath)) {
      throw this.notFound(skillId);
    }
    rmSync(skillPath, { recursive: true, force: true });
  }

  listFiles(request: SkillFileTreeRequest): SkillFileTreeResult {
    const skillId = this.normalizeSkillId(request.id);
    const skillRoot = join(this.paths.skillsDir, skillId);
    if (!existsSync(skillRoot)) {
      throw this.notFound(skillId);
    }
    const relativePath = this.normalizeSkillRelativePath(request.relativePath);
    const target = this.resolveInsideSkill(skillRoot, relativePath);
    const targetStat = statSync(target);
    if (!targetStat.isDirectory()) {
      throw new RocDomainError({
        code: 'skill_file_target_not_directory',
        message: 'Skill 文件树目标必须是目录。',
        category: 'validation',
        retryable: false,
        userAction: '请选择一个目录。'
      });
    }
    const children = readdirSync(target, { withFileTypes: true })
      .filter((entry) => !skillIgnoredDirectories.has(entry.name))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name, 'zh-Hans-CN');
      });
    const visibleChildren = children.slice(0, skillListLimit);
    const entries: SkillFileEntry[] = visibleChildren.map((entry) => {
      const absolutePath = join(target, entry.name);
      const entryStat = statSync(absolutePath);
      const entryRelative = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
      return {
        name: entry.name,
        relativePath: entryRelative,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entryStat.size,
        updatedAt: entryStat.mtime.toISOString()
      };
    });

    return {
      id: skillId,
      rootPath: skillRoot,
      relativePath,
      entries,
      truncated: children.length > visibleChildren.length
    };
  }

  private readSkill(id: string): SkillSnapshot | null {
    const skillPath = join(this.paths.skillsDir, id);
    const skillFile = join(skillPath, 'SKILL.md');
    if (!existsSync(skillFile)) {
      return null;
    }

    const state = this.readState(id);
    const content = readFileSync(skillFile, 'utf8');
    const nameMatch = /^name:\s*(.+)$/m.exec(content);
    const descriptionMatch = /^description:\s*(.+)$/m.exec(content);

    if (nameMatch === null) {
      return {
        id,
        name: id,
        enabled: false,
        path: skillPath,
        description: 'SKILL.md 缺少 name frontmatter。',
        status: 'invalid',
        lastError: 'SKILL.md 缺少 name frontmatter。'
      };
    }

    if (descriptionMatch === null) {
      return {
        id,
        name: nameMatch[1].trim(),
        enabled: false,
        path: skillPath,
        description: 'SKILL.md 缺少 description frontmatter。',
        status: 'invalid',
        lastError: 'SKILL.md 缺少 description frontmatter。'
      };
    }

    return {
      id,
      name: nameMatch[1].trim(),
      enabled: state.enabled,
      path: skillPath,
      description: descriptionMatch[1].trim(),
      status: 'ready',
      lastError: null
    };
  }

  private readState(id: string): SkillState {
    const statePath = join(this.paths.skillsDir, id, 'roc.skill.json');
    if (!existsSync(statePath)) {
      return defaultSkillState;
    }
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SkillState>;
    if (parsed.schemaVersion !== 1 || typeof parsed.enabled !== 'boolean') {
      return defaultSkillState;
    }
    return {
      schemaVersion: 1,
      enabled: parsed.enabled
    };
  }

  private writeState(id: string, state: SkillState): void {
    writeFileSync(join(this.paths.skillsDir, id, 'roc.skill.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  private normalizeSkillId(value: string): string {
    const trimmed = this.requireText(value, 'skill_id_empty', 'Skill ID 不能为空。', '请提供 Skill ID。');
    const normalized = basename(trimmed);
    if (normalized !== trimmed) {
      throw new RocDomainError({
        code: 'skill_id_invalid',
        message: 'Skill ID 不能包含路径分隔符。',
        category: 'validation',
        retryable: false,
        userAction: '请使用简单目录名作为 Skill ID。'
      });
    }
    return normalized;
  }

  private notFound(id: string): RocDomainError {
    return new RocDomainError({
      code: 'skill_not_found',
      message: `找不到 Skill ${id}。`,
      category: 'not_found',
      retryable: false,
      userAction: '请刷新能力管理页后重试。'
    });
  }

  private requireText(value: string, code: string, message: string, userAction: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code,
        message,
        category: 'validation',
        retryable: false,
        userAction
      });
    }
    return trimmed;
  }

  private normalizeSkillRelativePath(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === '.') {
      return '';
    }
    return trimmed.replaceAll('\\', '/');
  }

  private resolveInsideSkill(skillRoot: string, relativePath: string): string {
    const absoluteRoot = resolve(skillRoot);
    const target = resolve(absoluteRoot, relativePath);
    if (target !== absoluteRoot && !target.startsWith(absoluteRoot + sep)) {
      throw new RocDomainError({
        code: 'skill_file_outside_skill_root',
        message: 'Skill 文件路径越界。',
        category: 'validation',
        retryable: false,
        userAction: '请只访问该 Skill 目录内部的文件。'
      });
    }
    if (!existsSync(target)) {
      throw new RocDomainError({
        code: 'skill_file_target_missing',
        message: 'Skill 文件不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请刷新文件列表后重试。'
      });
    }
    return target;
  }
}
