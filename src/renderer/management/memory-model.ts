import type {
  AutoMemoryAuditAction,
  AutoMemoryAuditRecord,
  AutoMemoryCandidateType,
  AutoMemoryConfidence,
  MemoryFileMeta,
  MemoryFileWriteOutcome,
  MemoryKind,
  MemoryScope,
  MemoryStatus
} from '../../shared/types';

/**
 * Memory projections (P9/T9.1).
 *
 * Type-only imports (esbuild-bundleable for the unit test, ADR-M08 discipline).
 *
 * ## What the backend actually has
 *
 * The contract is narrower than the phase text, and three of the differences change the UI
 * (F24):
 *
 *  1. **There are five slots, not four.** `store-slots.ts` resolves
 *     `global/{user,agents,memory}`, `workspace/agents`, `workspace/memory`; `workspace/user`
 *     is explicitly refused (`USER.md lives only at /memory/global/USER.md`). The phase text's
 *     four-file list omits the project `AGENTS.md`.
 *  2. **A slot is a virtual path, not a file on disk.** The meta's `absolutePath` is
 *     `/memory/global/USER.md` and the content lives in a SQLite record
 *     (`createMarkdownFileValue` → `{content, mimeType, created_at, modified_at}`). "The truth
 *     is markdown" is true of the *content*; claiming a filesystem file would be false, so the
 *     UI shows the virtual path and offers no "reveal in Finder".
 *  3. **Content round-trips verbatim** (no frontmatter is added around it), and `charCount`
 *     counts **code points** (`[...content].length`), which is why the capacity bar must not
 *     use `String.length` (an emoji would count twice).
 *
 * ## Why the structured view is a projection and nothing more
 *
 * `memory.entries.search` / `memory.entry.remember` exist in the plugin but are **not** in
 * `ipc-registry.ts` (B25), so there is no renderer-side memory record to read or write. The
 * outline below is therefore derived from the *editor text* on every render: it can never
 * disagree with what would be saved, and it is not a second copy of any entity.
 */

/* ------------------------------------------------------------------ */
/* Slots                                                               */
/* ------------------------------------------------------------------ */

export type MemorySlot = {
  scope: MemoryScope;
  kind: MemoryKind;
  fileName: string;
  /** The backend's identity for this slot (`/memory/global/USER.md`). */
  virtualPath: string;
  label: string;
  purpose: string;
  /** Workspace slots need a bound working directory (`workspace_required`). */
  requiresWorkspace: boolean;
};

/** Exactly the five slots `listMemorySlots` produces, in the backend's order. */
export const MEMORY_SLOTS: readonly MemorySlot[] = [
  {
    scope: 'global',
    kind: 'user',
    fileName: 'USER.md',
    virtualPath: '/memory/global/USER.md',
    label: 'USER.md（全局）',
    purpose: '你的长期偏好：称呼、语言、输出风格。',
    requiresWorkspace: false
  },
  {
    scope: 'global',
    kind: 'agents',
    fileName: 'AGENTS.md',
    virtualPath: '/memory/global/AGENTS.md',
    label: 'AGENTS.md（全局）',
    purpose: '跨项目的行为准则与工作方式。',
    requiresWorkspace: false
  },
  {
    scope: 'global',
    kind: 'memory',
    fileName: 'MEMORY.md',
    virtualPath: '/memory/global/MEMORY.md',
    label: 'MEMORY.md（全局）',
    purpose: '与项目无关的长期事实；主题文件从这里的索引指向。',
    requiresWorkspace: false
  },
  {
    scope: 'workspace',
    kind: 'agents',
    fileName: 'AGENTS.md',
    virtualPath: '/memory/workspaces/current/AGENTS.md',
    label: 'AGENTS.md（当前工作目录）',
    purpose: '只在这个工作目录里生效的行为准则。',
    requiresWorkspace: true
  },
  {
    scope: 'workspace',
    kind: 'memory',
    fileName: 'MEMORY.md',
    virtualPath: '/memory/workspaces/current/MEMORY.md',
    label: 'MEMORY.md（当前工作目录）',
    purpose: '只属于这个工作目录的长期事实。',
    requiresWorkspace: true
  }
];

export function memorySlotKey(scope: MemoryScope, kind: MemoryKind): string {
  return `${scope}:${kind}`;
}

export function findSlot(scope: MemoryScope, kind: MemoryKind): MemorySlot | null {
  return MEMORY_SLOTS.find((slot) => slot.scope === scope && slot.kind === kind) ?? null;
}

/**
 * Why a slot is not usable.
 *
 * The workspace slots report `workspace_required`, and the reason is **not** "bind a working
 * directory": the shell bootstraps the memory plugin with `getWorkspace: () => null`
 * (`main-kernel-bootstrap.ts`), so `memory.status.workspaceHash` is always null and the two
 * project slots can never resolve (backend task B26). Saying "bind a workspace first" would send
 * the user to do something that cannot work.
 */
export function slotUnavailableReason(meta: MemoryFileMeta | null, slot: MemorySlot): string | null {
  if (meta === null) {
    return '后端没有返回这个槽位。';
  }
  if (meta.effective) {
    return null;
  }
  return slot.requiresWorkspace
    ? '项目槽位不可用：记忆插件当前没有接到工作目录（B26）'
    : '当前不可用。';
}

/** The one-line explanation shown above the slot list when project slots exist but cannot resolve. */
export const MEMORY_WORKSPACE_UNAVAILABLE_NOTE =
  '项目级槽位（/memory/workspaces/current/{AGENTS,MEMORY}.md）在当前构建里永远不可用：主进程给记忆插件传的 workspace provider 是 `() => null`，所以 memory.status.workspaceHash 始终为 null、读写作都返回 workspace_required（后端任务单 B26）。三份全局文件不受影响。';

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

export type CapacityState = 'ok' | 'near' | 'over';

/** Ratio is `null` when the backend reports no limit (it always does today). */
export function capacityRatio(meta: MemoryFileMeta | null): number | null {
  if (meta === null || meta.charLimit <= 0) {
    return null;
  }
  return meta.charCount / meta.charLimit;
}

export function capacityState(meta: MemoryFileMeta | null): CapacityState {
  const ratio = capacityRatio(meta);
  if (ratio === null) {
    return 'ok';
  }
  if (ratio > 1) {
    return 'over';
  }
  return ratio >= 0.9 ? 'near' : 'ok';
}

/**
 * Code-point count, matching the backend's accounting.
 *
 * `String.length` counts UTF-16 units, so a single emoji would read as 2 and the bar would
 * disagree with `memory.status.charCount` after a save.
 */
export function codePointCount(text: string): number {
  return [...text].length;
}

/** `1,234 / 20,000 字符（6%）` — the same numbers the save will be judged by. */
export function capacityLabel(meta: MemoryFileMeta | null, draftLength: number | null = null): string {
  if (meta === null) {
    return '容量未知';
  }
  const used = draftLength === null ? meta.charCount : draftLength;
  const ratio = meta.charLimit <= 0 ? 0 : Math.round((used / meta.charLimit) * 100);
  return `${used.toLocaleString('en-US')} / ${meta.charLimit.toLocaleString('en-US')} 字符（${ratio}%）`;
}

/* ------------------------------------------------------------------ */
/* Write outcome                                                       */
/* ------------------------------------------------------------------ */

export type MemoryIssueLine = { category: string; pattern: string; excerpt: string };

export type WriteOutcomeDescription = {
  status: 'saved' | 'blocked';
  message: string;
  issues: MemoryIssueLine[];
};

const writeFailureLabels: Readonly<Record<string, string>> = {
  security_scan: '被安全扫描拦下，未写入',
  capacity_exceeded: '超出容量上限，未写入',
  invalid_path: '这个槽位不存在，未写入',
  workspace_required: '需要先绑定工作目录，未写入'
};

/**
 * A refused write is a **domain outcome**, not an IPC error (`{ok:false, reason, …}` inside a
 * successful result), so the caller must branch on the payload — treating it as a failure
 * would drop the scan findings, which are the actionable part.
 */
export function describeWriteOutcome(outcome: MemoryFileWriteOutcome): WriteOutcomeDescription {
  if (outcome.ok) {
    return { status: 'saved', message: `已写入 ${outcome.meta.absolutePath}（${outcome.meta.charCount} 字符）`, issues: [] };
  }
  const issues: MemoryIssueLine[] = (outcome.issues ?? []).map((issue) => ({
    category: issue.category,
    pattern: issue.pattern,
    excerpt: issue.matchExcerpt
  }));
  // Same grouping as `capacityLabel`, so the number the user sees in the bar and in the refusal
  // are the same string.
  const capacity =
    outcome.chars === undefined || outcome.limit === undefined
      ? ''
      : `（${outcome.chars.toLocaleString('en-US')} / ${outcome.limit.toLocaleString('en-US')} 字符）`;
  return {
    status: 'blocked',
    message: `${writeFailureLabels[outcome.reason] ?? outcome.reason}：${outcome.detail}${capacity}`,
    issues
  };
}

/* ------------------------------------------------------------------ */
/* Markdown outline (a projection of the editor text)                   */
/* ------------------------------------------------------------------ */

export type MemoryOutlineEntry = {
  /** 1-based heading level. */
  level: number;
  title: string;
  /** 1-based line number of the heading. */
  line: number;
  /** Character offset of the heading's line start, for selecting it in the textarea. */
  offset: number;
};

/**
 * ATX headings only (`#` … `######`), skipping fenced code blocks so a `# comment` inside a
 * shell snippet does not become an outline entry. Derived, never stored.
 */
export function outlineFromMarkdown(text: string): MemoryOutlineEntry[] {
  const entries: MemoryOutlineEntry[] = [];
  let offset = 0;
  let insideFence = false;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      insideFence = !insideFence;
      offset += line.length + 1;
      return;
    }
    if (!insideFence) {
      const match = /^(#{1,6})\s+(.*)$/u.exec(line);
      if (match !== null) {
        const [, hashes = '', title = ''] = match;
        entries.push({ level: hashes.length, title: title.trim(), line: index + 1, offset });
      }
    }
    offset += line.length + 1;
  });
  return entries;
}

/* ------------------------------------------------------------------ */
/* Auto-memory audit (the only structured memory view the IPC exposes)  */
/* ------------------------------------------------------------------ */

export const autoMemoryActionLabels: Readonly<Record<AutoMemoryAuditAction, string>> = {
  accepted: '已采纳',
  rejected: '被拒',
  duplicate_skipped: '重复，跳过',
  conflict_rejected: '冲突，拒绝',
  maintenance_merged: '维护时合并',
  maintenance_deleted: '维护时删除',
  write_failed: '写入失败'
};

export const autoMemoryTypeLabels: Readonly<Record<AutoMemoryCandidateType, string>> = {
  user_preference: '用户偏好',
  workspace_fact: '工作目录事实',
  decision: '决策',
  pitfall: '坑',
  verification: '验证',
  transient_task_result: '一次性任务结果'
};

export const autoMemoryConfidenceLabels: Readonly<Record<AutoMemoryConfidence, string>> = {
  high: '高',
  medium: '中',
  low: '低'
};

export function auditRecordLine(record: AutoMemoryAuditRecord): string {
  return `${autoMemoryActionLabels[record.action]} · ${autoMemoryTypeLabels[record.type]} · ${autoMemoryConfidenceLabels[record.confidence]} · ${record.summary}`;
}

/* ------------------------------------------------------------------ */
/* Snapshot preview consistency                                        */
/* ------------------------------------------------------------------ */

/**
 * Whether the preview the user is looking at actually contains this slot.
 *
 * `buildSnapshotPreview` joins the **effective, non-empty** slots as `## <virtualPath>` plus
 * the content, so the heading is the reliable marker. Used by the UI to explain why a slot the
 * user can see in the editor is absent from the preview (empty, or not effective).
 */
export function snapshotIncludesSlot(previewText: string, slot: MemorySlot): boolean {
  return previewText.includes(`## ${slot.virtualPath}`);
}

/* ------------------------------------------------------------------ */
/* Assistant hand-off prompt                                           */
/* ------------------------------------------------------------------ */

/**
 * The prompt for 「用助手整理记忆」.
 *
 * It asks for a **replacement draft**, never for a write: the management panel has no run
 * channel of its own (runs belong to the assistant panel), so the honest flow is
 * prefill → user reads the reply → user pastes what they accept into the editor, where the
 * normal save path (and its security scan) still applies.
 */
export function buildMemoryAssistPrompt(slot: MemorySlot, currentContent: string): string {
  const body = currentContent.trim().length === 0 ? '（当前是空的）' : currentContent.trim();
  return [
    `请帮我把记忆文件 ${slot.virtualPath} 整理成一份可直接替换的 Markdown 草稿。`,
    `用途：${slot.purpose}`,
    '要求：保留所有仍然有效的事实，去掉重复与过期内容，按主题分组，不要编造新事实。',
    '只输出 Markdown 正文（不要解释、不要加代码围栏），我会自己核对后再粘贴到编辑器。',
    '',
    '当前内容：',
    '"""',
    body,
    '"""'
  ].join('\n');
}
