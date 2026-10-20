import type {
  BuiltinSkillSourceStatus,
  SkillFileEntry,
  SkillFilePreviewResult,
  SkillSnapshot
} from '../../shared/types';

/**
 * Skill projections (P9/T9.2).
 *
 * Type-only imports. Four phase-text claims do not survive contact with the contract and are
 * recorded instead of implemented (F24):
 *
 *  - **No category, version, source or license field.** `skillSnapshotSchema` is
 *    `{id, name, enabled, path, description, status, lastError}` and the plugin registers with
 *    the same schema, so there is nothing to show and nothing to filter by.
 *  - **No ZIP import.** `SkillService.importSkill` resolves `sourcePath` as a **directory**
 *    containing `SKILL.md` (a missing file is `skill_file_missing`).
 *  - **No directory picker that does not rebind the workspace.** `files.selectFromDialog`
 *    returns files; `workspace.selectFromDialog` *binds* the chosen directory as the working
 *    directory. So the import field is a path the user provides, and the panel says why.
 *  - **`status` is `ready | invalid`**, not a longer lifecycle.
 *
 * The license boundary is a **documentation** obligation (CONTEXT.md 许可), not a field, so it
 * is stated as text next to the list rather than invented per skill.
 */

export const LICENSE_BOUNDARY_NOTE =
  '许可边界：内置开源技能（Apache-2.0 / MIT 等）可随 Roc 分发；受 CC BY-NC 4.0 等限制的非商业技能插件只能在许可允许的边界内作为独立插件分发，不能伪装成 Roc 核心的标准开源内容。';

export const BUILTIN_SKILLS_NOTE =
  '两个上游仓库的技能快照随 Roc 分发出厂，离线可用；之后每天比对一次上游提交，有变化就同步到本机。Nature Skills 是 Apache-2.0；Academic Research Skills 是 CC BY-NC 4.0（非商业），只在你明确安装后才会启用和自动更新。';

export const SKILL_FIELD_NOTE =
  '技能快照是 id / 名称 / 描述 / 路径 / 启停 / 状态（ready·invalid）/ 来源（内置·用户）/ 上游仓库与提交：仍然没有分类与版本字段，所以这里不按分类或版本筛选。';

export const skillStatusLabels: Readonly<Record<SkillSnapshot['status'], string>> = {
  ready: '可用',
  invalid: '无效'
};

/** Enabled first, then by name — the order the composer's `/skill` list follows. */
export function sortSkills(skills: readonly SkillSnapshot[]): SkillSnapshot[] {
  return [...skills].sort((left, right) => {
    if (left.enabled !== right.enabled) {
      return left.enabled ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function skillSummary(skills: readonly SkillSnapshot[]): string {
  const enabled = skills.filter((skill) => skill.enabled).length;
  const invalid = skills.filter((skill) => skill.status === 'invalid').length;
  return `${skills.length} 个技能 · ${enabled} 个已启用${invalid === 0 ? '' : ` · ${invalid} 个无效`}`;
}

/**
 * The import field's own validation.
 *
 * An absolute path is required because the backend `resolve()`s the string against the process
 * cwd: a relative path would point at Roc's own directory, which is never what the user means.
 */
export function validateSkillImportPath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return null; // empty is "not filled in yet", not an error
  }
  if (trimmed.includes('\u0000')) {
    return '路径不能包含空字符。';
  }
  if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(trimmed)) {
    return '请填绝对路径（后端会按进程工作目录解析相对路径，那不是你选的目录）。';
  }
  return null;
}

export function validateSkillImportPathRequired(path: string): string | null {
  if (path.trim().length === 0) {
    return '先填要导入的技能目录（必须包含 SKILL.md）。';
  }
  return validateSkillImportPath(path);
}

/* ------------------------------------------------------------------ */
/* File tree                                                           */
/* ------------------------------------------------------------------ */

export function joinRelativePath(base: string, name: string): string {
  const trimmed = base.trim().replace(/\/+$/u, '');
  return trimmed.length === 0 ? name : `${trimmed}/${name}`;
}

export function parentRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim().replace(/\/+$/u, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '' : trimmed.slice(0, index);
}

/** Breadcrumb segments; `''` is the root and is rendered as the skill's own name. */
export function pathSegments(relativePath: string): string[] {
  return relativePath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function sortEntries(entries: readonly SkillFileEntry[]): SkillFileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export type FilePreviewKind = 'markdown' | 'text' | 'image' | 'binary';

/**
 * How to render a preview.
 *
 * `kind: 'image'` ships `content` as a **`data:` URL** already (`skill-service.ts` builds it),
 * so the panel can use it directly as `src` — no Blob URL, no `createObjectURL` (the P3/P7
 * rule). Markdown is only the extension's call: `kind: 'text'` for a `.md` file is still just
 * text, and rendering it as markdown is a presentation choice, not a backend one.
 */
export function filePreviewKind(preview: SkillFilePreviewResult): FilePreviewKind {
  if (preview.kind === 'image') {
    return 'image';
  }
  if (preview.kind === 'binary') {
    return 'binary';
  }
  const lower = preview.relativePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') ? 'markdown' : 'text';
}

export function previewSizeLabel(preview: SkillFilePreviewResult): string {
  return `${preview.sizeBytes.toLocaleString('en-US')} B${preview.truncated ? ' · 已截断（只读预览）' : ''}`;
}

/** `truncated` means the panel must not offer an edit affordance (it never does) nor compare sizes. */
export function previewTruncatedNote(preview: SkillFilePreviewResult): string | null {
  return preview.truncated ? '预览被截断：文件比预览上限大，这里只显示开头部分。' : null;
}

/* ------------------------------------------------------------------ */
/* Built-in sources                                                    */
/* ------------------------------------------------------------------ */

/** `null`/empty renders as `—` so a source that never checked is visibly different from one at 0. */
export function formatBuiltinTimestamp(value: string | null): string {
  if (value === null || value.length === 0) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function shortCommit(commit: string | null): string {
  if (commit === null || commit.length === 0) {
    return '—';
  }
  return commit.slice(0, 8);
}

/** Non-commercial sources need an explicit install; the label says what the click means. */
export function builtinSourceActionLabel(source: BuiltinSkillSourceStatus): string {
  if (source.installedCommit === null) {
    return source.license === null ? '安装内置技能' : `接受 ${source.license} 并安装`;
  }
  return '重新安装内置版本';
}

export function builtinSourceSummary(source: BuiltinSkillSourceStatus): string {
  const installed = source.installedCommit === null ? '未安装' : `已安装 ${source.skillIds.length} 个技能`;
  return `${installed} · 内置 ${shortCommit(source.bundledCommit)} · 上游 ${shortCommit(source.installedCommit)}`;
}
