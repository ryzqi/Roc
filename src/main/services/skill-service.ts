import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { listSkills, parseSkillMetadata, type LoaderSkillMetadata } from 'deepagents';
import type {
  SkillFileEntry,
  SkillFilePreviewRequest,
  SkillFilePreviewResult,
  SkillFileTreeRequest,
  SkillFileTreeResult,
  SkillImportRequest,
  SkillSnapshot
} from '../../shared/types';
import { RocDomainError } from './errors';
import type { LogService } from './log-service';
import type { RocPaths } from './paths';
import { requireText } from './validation';

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
const skillPreviewBytes = 64 * 1024;
const skillImageMediaTypes = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml']
]);

export class SkillService {
  constructor(private readonly paths: RocPaths) {}

  list(): SkillSnapshot[] {
    if (!existsSync(this.paths.skillsDir)) {
      return [];
    }

    const officialSkillIndex = this.buildOfficialSkillIndex();

    return readdirSync(this.paths.skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readSkill(entry.name, officialSkillIndex))
      .filter((entry): entry is SkillSnapshot => entry !== null);
  }

  importSkill(request: SkillImportRequest): SkillSnapshot {
    const sourcePath = requireText(request.sourcePath, 'skill_source_empty', 'Skill sourcePath 不能为空。', '请选择本地 Skill 目录。');
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
    const metadata = parseSkillMetadata(sourceSkillFile, 'user');
    if (metadata === null) {
      throw new RocDomainError({
        code: 'skill_invalid',
        message: 'SKILL.md 不符合 Deep Agents Skill 规范。',
        category: 'validation',
        retryable: false,
        userAction: '请修复 SKILL.md frontmatter 后重试。'
      });
    }
    const id = this.normalizeSkillId(metadata.name);
    const targetRoot = join(this.paths.skillsDir, id);
    const priorState = this.readState(id);
    if (resolve(targetRoot) !== sourceRoot) {
      rmSync(targetRoot, { recursive: true, force: true });
      mkdirSync(targetRoot, { recursive: true });
      for (const entry of readdirSync(sourceRoot)) {
        cpSync(join(sourceRoot, entry), join(targetRoot, entry), { recursive: true });
      }
    }
    this.writeState(id, priorState);
    const imported = this.readSkill(id, this.buildOfficialSkillIndex());
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

  migrateLegacySkills(input: { legacySkillsDir: string; logService?: Pick<LogService, 'append'> }): void {
    const legacyRoot = resolve(input.legacySkillsDir);
    const currentRoot = resolve(this.paths.skillsDir);
    if (legacyRoot === currentRoot || !existsSync(legacyRoot)) {
      return;
    }

    const entries = readdirSync(legacyRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (entries.length === 0) {
      return;
    }

    mkdirSync(this.paths.skillsDir, { recursive: true });
    const summary = {
      scannedSkills: entries.length,
      createdSkills: 0,
      copiedFiles: 0,
      updatedFiles: 0,
      skippedFiles: 0
    };

    for (const entry of entries) {
      const sourceDir = join(legacyRoot, entry.name);
      const targetDir = join(this.paths.skillsDir, entry.name);
      if (!existsSync(targetDir)) {
        summary.createdSkills += 1;
      }
      mkdirSync(targetDir, { recursive: true });
      this.mergeSkillDirectory(sourceDir, targetDir, summary);
    }

    input.logService?.append({
      level: 'info',
      message: 'Migrated legacy root-scoped skills into the canonical user skill library.',
      data: summary
    });
  }

  setEnabled(id: string, enabled: boolean): SkillSnapshot {
    const skillId = this.normalizeSkillId(id);
    const officialSkillIndex = this.buildOfficialSkillIndex();
    const skill = this.readSkill(skillId, officialSkillIndex);
    if (skill === null) {
      throw this.notFound(skillId);
    }
    this.writeState(skillId, {
      schemaVersion: 1,
      enabled
    });
    const updated = this.readSkill(skillId, officialSkillIndex);
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

  readFile(request: SkillFilePreviewRequest): SkillFilePreviewResult {
    const skillId = this.normalizeSkillId(request.id);
    const skillRoot = join(this.paths.skillsDir, skillId);
    if (!existsSync(skillRoot)) {
      throw this.notFound(skillId);
    }
    const relativePath = this.normalizeSkillRelativePath(request.relativePath);
    if (relativePath.length === 0) {
      throw new RocDomainError({
        code: 'skill_file_target_not_file',
        message: 'Skill 文件预览目标必须是文件。',
        category: 'validation',
        retryable: false,
        userAction: '请选择一个文件。'
      });
    }
    const target = this.resolveInsideSkill(skillRoot, relativePath);
    const targetStat = statSync(target);
    if (!targetStat.isFile()) {
      throw new RocDomainError({
        code: 'skill_file_target_not_file',
        message: 'Skill 文件预览目标必须是文件。',
        category: 'validation',
        retryable: false,
        userAction: '请选择一个文件。'
      });
    }
    const maxBytes = request.maxBytes === undefined ? skillPreviewBytes : request.maxBytes;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new RocDomainError({
        code: 'skill_file_invalid_limit',
        message: 'maxBytes 必须是正整数。',
        category: 'validation',
        retryable: true,
        userAction: '请提供正整数 maxBytes。'
      });
    }
    const buffer = readFileSync(target);
    const mediaType = this.skillImageMediaTypeForPath(relativePath);
    if (mediaType !== null) {
      return {
        id: skillId,
        relativePath,
        kind: 'image',
        mediaType,
        content: `data:${mediaType};base64,${buffer.toString('base64')}`,
        truncated: false,
        sizeBytes: buffer.byteLength
      };
    }
    if (this.isSkillBinaryBuffer(buffer)) {
      return {
        id: skillId,
        relativePath,
        kind: 'binary',
        content: '',
        truncated: false,
        sizeBytes: buffer.byteLength
      };
    }
    return {
      id: skillId,
      relativePath,
      kind: 'text',
      content: buffer.subarray(0, maxBytes).toString('utf8'),
      truncated: buffer.byteLength > maxBytes,
      sizeBytes: buffer.byteLength
    };
  }

  private readSkill(id: string, officialSkillIndex: ReadonlyMap<string, LoaderSkillMetadata>): SkillSnapshot | null {
    const skillPath = join(this.paths.skillsDir, id);
    const skillFile = join(skillPath, 'SKILL.md');
    if (!existsSync(skillFile)) {
      return null;
    }

    const metadata = parseSkillMetadata(skillFile, 'user');
    if (metadata === null) {
      return this.createInvalidSkillSnapshot(id, skillPath, 'SKILL.md 不符合 Deep Agents Skill 规范。');
    }

    if (metadata.name !== id || !officialSkillIndex.has(resolve(skillFile))) {
      return this.createInvalidSkillSnapshot(
        id,
        skillPath,
        `SKILL.md name "${metadata.name}" 必须与目录名 "${id}" 一致。`,
        metadata.description
      );
    }

    const state = this.readState(id);
    return {
      id: metadata.name,
      name: metadata.name,
      enabled: state.enabled,
      path: skillPath,
      description: metadata.description,
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

  private buildOfficialSkillIndex(): Map<string, LoaderSkillMetadata> {
    return new Map(
      listSkills({ userSkillsDir: this.paths.skillsDir }).map((skill) => [resolve(skill.path), skill] as const)
    );
  }

  private createInvalidSkillSnapshot(
    id: string,
    skillPath: string,
    lastError: string,
    description = lastError
  ): SkillSnapshot {
    return {
      id,
      name: id,
      enabled: false,
      path: skillPath,
      description,
      status: 'invalid',
      lastError
    };
  }

  private normalizeSkillId(value: string): string {
    const trimmed = requireText(value, 'skill_id_empty', 'Skill ID 不能为空。', '请提供 Skill ID。');
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

  private skillImageMediaTypeForPath(relativePath: string): string | null {
    const normalized = relativePath.toLowerCase();
    for (const [extension, mediaType] of skillImageMediaTypes.entries()) {
      if (normalized.endsWith(extension)) {
        return mediaType;
      }
    }
    return null;
  }

  private isSkillBinaryBuffer(buffer: Buffer): boolean {
    return buffer.subarray(0, 4096).includes(0);
  }

  private mergeSkillDirectory(
    sourceDir: string,
    targetDir: string,
    summary: { copiedFiles: number; updatedFiles: number; skippedFiles: number }
  ): void {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(targetPath, { recursive: true });
        this.mergeSkillDirectory(sourcePath, targetPath, summary);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!existsSync(targetPath)) {
        cpSync(sourcePath, targetPath);
        summary.copiedFiles += 1;
        continue;
      }

      if (entry.name === 'roc.skill.json') {
        summary.skippedFiles += 1;
        continue;
      }

      const sourceStat = statSync(sourcePath);
      const targetStat = statSync(targetPath);
      if (sourceStat.mtimeMs > targetStat.mtimeMs) {
        cpSync(sourcePath, targetPath, { force: true });
        summary.updatedFiles += 1;
        continue;
      }

      summary.skippedFiles += 1;
    }
  }
}
