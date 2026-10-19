import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, FileText, RefreshCw, Save, Search, Undo2 } from 'lucide-react';
import type { MemoryStatus } from '../../../shared/types';
import { formatBeijingDateTime } from '../../shared/format';
import { FormNote, FormSection, KeyValueRow, formInputClass, formSecondaryButtonClass, formTextAreaClass } from '../../shared/form-ui';
import type { ManagementScope } from '../management-scope';
import {
  MEMORY_WORKSPACE_UNAVAILABLE_NOTE,
  auditRecordLine,
  buildMemoryAssistPrompt,
  capacityLabel,
  capacityState,
  codePointCount,
  outlineFromMarkdown,
  slotUnavailableReason,
  snapshotIncludesSlot
} from '../memory-model';
import { useMemorySnapshot, useSessionSearch, type MemoryFilesStore } from '../use-memory';

/**
 * 记忆 (P9/T9.1).
 *
 * The surface is a **markdown editor over five slots** plus three read-only facts, because that is
 * what the contract has (F24):
 *
 *  - `memory.status` → the slot metadata, the capacity limits, the session-retention numbers, the
 *    full-text-index health and the auto-memory audit;
 *  - `memory.file.read` / `memory.file.write` → the editor. A refused write is a **domain
 *    outcome** (`{ok:false, reason, issues}`) and is rendered as a blocked save with the scan
 *    findings, never as a generic error;
 *  - `memory.snapshot.preview` → the text that would be injected into the next run;
 *  - `agent.sessions.search` → 「从会话里找」. The memory domain's own
 *    `memory.entries.search` / `memory.entry.remember` are declared by the plugin but have no IPC
 *    channel (B25), so there is no structured memory entity to browse — the outline next to the
 *    editor is a projection of the text on screen and nothing is stored twice.
 *
 * 「用助手整理记忆」 does not start a run: run state and the transcript belong to the assistant
 * panel, so the button hands a prompt to its composer (`onAskAssistant`) and the user decides what
 * to keep. Nothing is written without the normal save path (and its security scan).
 */

/**
 * Outline indentation as Tailwind steps rather than an inline `paddingLeft`.
 *
 * (level - 1) * 8 + 4 px expressed in the 4px scale Tailwind already has: an inline style for a
 * static indent would be the one place in this panel that bypasses the design tokens.
 */
const OUTLINE_INDENT = ['pl-1', 'pl-3', 'pl-5', 'pl-7', 'pl-9', 'pl-11'] as const;

function capacityTone(state: ReturnType<typeof capacityState>): string {
  if (state === 'over') {
    return 'text-[var(--st-bad)]';
  }
  if (state === 'near') {
    return 'text-[var(--st-warn)]';
  }
  return 'text-muted';
}

export function MemorySection({
  scope,
  store: files
}: {
  scope: ManagementScope;
  store: MemoryFilesStore;
}): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const preview = useMemorySnapshot(scope.client, previewRevision);
  const search = useSessionSearch(scope.client, files.memory?.workspaceHash ?? null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const outline = useMemo(() => outlineFromMarkdown(files.draft), [files.draft]);
  const draftLength = codePointCount(files.draft);
  const selectedRow = files.rows.find((row) => row.slot.scope === files.selected.scope && row.slot.kind === files.selected.kind) ?? null;
  const selectedMeta = selectedRow?.meta ?? null;
  // An ineffective slot cannot be written: the backend returns `workspace_required`, so the button
  // would be a guaranteed failure (and the reason is a missing working-directory binding, not a
  // user mistake).
  const slotWritable = selectedMeta !== null && selectedMeta.effective;

  // Only "no status yet" is a loading state: a refresh keeps the files and the editor on screen.
  if (files.memory === null) {
    return files.status === 'error' ? (
      <FormNote tone="warn" testId="mgmt-memory-error">
        读取记忆状态失败：{files.error}
      </FormNote>
    ) : (
      <FormNote testId="mgmt-memory-loading">正在读取记忆状态…</FormNote>
    );
  }

  const memory: MemoryStatus = files.memory;
  const saveOutcome = files.save.outcome;
  const oldestSessionAt = memory.sessionMessages.oldestAt;
  const fullTextIndexState = memory.fullTextIndex.healthy
    ? '健康'
    : '异常（全文索引不可用，会话检索会退化为无结果）';

  const requestSave = (): void => {
    void files.save.run().then((saved) => {
      if (saved) {
        setPreviewRevision((current) => current + 1);
      }
    });
  };

  const selectOutline = (offset: number, title: string, level: number): void => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }
    textarea.focus();
    const start = offset + level + 1;
    textarea.setSelectionRange(start, start + title.length);
  };

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="mgmt-memory">
      <FormSection
        title="记忆文件（markdown，五份）"
        hint="memory.status / memory.file.read / memory.file.write"
        testId="mgmt-memory-files"
      >
        <dl className="flex flex-col gap-0.5">
          <KeyValueRow label="存储位置" value={memory.root} testId="mgmt-memory-root" />
          <KeyValueRow
            label="工作目录"
            value={memory.workspaceLabel ?? '未绑定（项目槽位不可用）'}
            testId="mgmt-memory-workspace"
          />
          <KeyValueRow
            label="快照注入"
            value={`${memory.snapshot.enabled ? '启用' : '停用'} · ${memory.snapshot.totalChars} / ${memory.snapshot.totalLimit} 字符`}
            testId="mgmt-memory-snapshot-state"
          />
          <KeyValueRow
            label="会话消息"
            value={`${memory.sessionMessages.totalRows} 行 · 保留 ${memory.sessionMessages.retentionDays} 天 · 最早 ${oldestSessionAt === null ? '—' : formatBeijingDateTime(oldestSessionAt)}`}
            testId="mgmt-memory-sessions"
          />
          <KeyValueRow
            label="全文索引"
            value={fullTextIndexState}
            testId="mgmt-memory-index"
          />
        </dl>

        {memory.workspaceHash === null ? (
          <FormNote testId="mgmt-memory-workspace-note">{MEMORY_WORKSPACE_UNAVAILABLE_NOTE}</FormNote>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="mgmt-memory-reload"
            disabled={files.status === 'loading'}
            onClick={() => files.reload()}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <RefreshCw size={11} aria-hidden="true" />
            重新读取
          </button>
          <span className="text-subtle text-[var(--font-micro-size)]">
            容量、会话保留、全文索引与审计记录都来自这一次读取；保存成功后会自动重读。
          </span>
        </div>

        <ul className="flex flex-col gap-1" data-testid="mgmt-memory-slots">
          {files.rows.map(({ slot, meta }) => {
            const selected = slot.scope === files.selected.scope && slot.kind === files.selected.kind;
            const state = capacityState(meta);
            const dirty = files.dirty(slot);
            return (
              <li key={`${slot.scope}:${slot.kind}`}>
                <button
                  type="button"
                  onClick={() => files.selectSlot(slot.scope, slot.kind)}
                  data-testid={`mgmt-memory-slot-${slot.scope}-${slot.kind}`}
                  data-dirty={dirty ? 'true' : 'false'}
                  className={
                    selected
                      ? 'flex w-full flex-col gap-0.5 rounded-card bg-accent-soft px-2 py-1.5 text-left'
                      : 'flex w-full flex-col gap-0.5 rounded-card px-2 py-1.5 text-left hover:bg-[var(--overlay-hover)]'
                  }
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <FileText size={12} aria-hidden="true" className="text-muted" />
                    <span className="text-ink text-[var(--font-meta-size)]">{slot.label}</span>
                    <span className="font-mono text-subtle text-[var(--font-micro-size)]">{slot.virtualPath}</span>
                    {dirty ? (
                      <span className="flex items-center gap-1 text-[var(--st-warn)] text-[var(--font-micro-size)]">
                        <AlertTriangle size={10} aria-hidden="true" />
                        未保存
                      </span>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-[var(--font-micro-size)]">
                    <span className={capacityTone(state)} data-testid={`mgmt-memory-capacity-${slot.scope}-${slot.kind}`}>
                      {meta === null
                        ? '后端未返回该槽位'
                        : meta.exists
                          ? capacityLabel(meta)
                          : `${slot.requiresWorkspace && !meta.effective ? '不可用' : '空文件'} · ${capacityLabel(meta)}`}
                    </span>
                    {state === 'over' ? <span className="text-[var(--st-bad)]">超出上限，写入会被拒</span> : null}
                    {state === 'near' ? <span className="text-[var(--st-warn)]">接近上限</span> : null}
                    {meta?.updatedAt === null || meta?.updatedAt === undefined ? null : (
                      <span className="text-subtle">更新于 {formatBeijingDateTime(meta.updatedAt)}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </FormSection>

      <FormSection
        title={`编辑 ${files.selected.virtualPath}`}
        hint="markdown 正文；结构化大纲只是这段文字的投影"
        testId="mgmt-memory-editor"
      >
        {files.contentError === null ? null : (
          <FormNote tone="warn" testId="mgmt-memory-content-error">
            读取文件失败：{files.contentError}
          </FormNote>
        )}
        {slotWritable ? null : (
          <FormNote tone="warn" testId="mgmt-memory-slot-unavailable">
            {slotUnavailableReason(selectedMeta, files.selected) ?? '这个槽位当前不可写。'}
          </FormNote>
        )}
        <div className="flex flex-col gap-2 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <textarea
              ref={textareaRef}
              value={files.draft}
              rows={14}
              spellCheck={false}
              disabled={files.contentLoading}
              onChange={(event) => files.setDraft(event.target.value)}
              data-testid="mgmt-memory-textarea"
              className={formTextAreaClass}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="mgmt-memory-save"
                disabled={!slotWritable || !files.dirty(files.selected) || files.save.pending}
                onClick={requestSave}
                className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
              >
                <Save size={11} aria-hidden="true" />
                {files.save.pending ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                data-testid="mgmt-memory-discard"
                disabled={!files.dirty(files.selected)}
                onClick={() => files.discard()}
                className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
              >
                <Undo2 size={11} aria-hidden="true" />
                放弃本文件改动
              </button>
              <button
                type="button"
                data-testid="mgmt-memory-assist"
                onClick={() => scope.onAskAssistant(buildMemoryAssistPrompt(files.selected, files.draft))}
                className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
              >
                <Bot size={11} aria-hidden="true" />
                用助手整理（只给建议稿）
              </button>
              <span className="text-subtle text-[var(--font-micro-size)]" data-testid="mgmt-memory-length">
                {draftLength.toLocaleString('en-US')} 字符
                {selectedMeta === null ? '' : ` · 上限 ${selectedMeta.charLimit.toLocaleString('en-US')}`}
              </span>
            </div>
            {saveOutcome === null ? null : (
              <FormNote tone={saveOutcome.status === 'saved' ? 'default' : 'warn'} testId="mgmt-memory-outcome">
                {saveOutcome.status === 'saved' ? `已保存：${saveOutcome.message}` : `未保存：${saveOutcome.message}`}
                {saveOutcome.issues.length === 0
                  ? ''
                  : ` · 命中：${saveOutcome.issues.map((issue) => `${issue.category}(${issue.pattern})`).join('、')}`}
              </FormNote>
            )}
            {files.save.error === null ? null : (
              <FormNote tone="warn" testId="mgmt-memory-save-error">
                {files.save.error}
              </FormNote>
            )}
          </div>

          <div className="flex w-full shrink-0 flex-col gap-1 lg:w-[220px]">
            <span className="text-subtle text-[var(--font-micro-size)]">
              大纲（{outline.length} 个标题，点击定位）
            </span>
            {outline.length === 0 ? (
              <span className="text-subtle text-[var(--font-micro-size)]" data-testid="mgmt-memory-outline-empty">
                这段文字还没有 Markdown 标题。
              </span>
            ) : (
              <ul className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto" data-testid="mgmt-memory-outline">
                {outline.map((entry) => (
                  <li key={`${entry.line}:${entry.title}`}>
                    <button
                      type="button"
                      onClick={() => selectOutline(entry.offset, entry.title, entry.level)}
                      data-testid={`mgmt-memory-outline-${entry.line}`}
                      className={`w-full truncate rounded-control pr-1 py-0.5 text-left text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink ${OUTLINE_INDENT[entry.level - 1] ?? 'pl-1'}`}
                    >
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <FormNote testId="mgmt-memory-projection-note">
              没有「结构化记忆条目」这种实体：后端把记忆存成 markdown 内容（虚拟路径 + SQLite 记录），
              `memory.entries.search` / `memory.entry.remember` 也没有 IPC 通道（B25）。所以上面的大纲是从编辑器文字实时派生的，不是第二份数据。
            </FormNote>
          </div>
        </div>
      </FormSection>

      <FormSection
        title="注入快照预览"
        hint="memory.snapshot.preview — 下一次运行真正会带上什么"
        testId="mgmt-memory-preview"
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="mgmt-memory-preview-toggle"
            onClick={() => {
              setPreviewOpen((current) => !current);
              setPreviewRevision((current) => current + 1);
            }}
            className={formSecondaryButtonClass}
          >
            {previewOpen ? '收起快照' : '展开快照'}
          </button>
          <span className="text-subtle text-[var(--font-micro-size)]" data-testid="mgmt-memory-preview-count">
            {preview.status === 'loading' ? '读取中…' : `${preview.charCount} 字符`}
          </span>
          <span className="text-subtle text-[var(--font-micro-size)]">
            {snapshotIncludesSlot(preview.text ?? '', files.selected) ? '当前文件在快照里' : '当前文件不在快照里（空文件或槽位未生效）'}
          </span>
        </div>
        {preview.error === null ? null : (
          <FormNote tone="warn" testId="mgmt-memory-preview-error">
            {preview.error}
          </FormNote>
        )}
        {previewOpen ? (
          <pre
            className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-card border border-line bg-bg-soft px-2 py-1.5 font-mono text-[var(--font-code-size)] text-muted"
            data-testid="mgmt-memory-preview-text"
          >
            {preview.text ?? ''}
          </pre>
        ) : null}
      </FormSection>

      <FormSection
        title="从会话里找"
        hint="agent.sessions.search（memory 域没有条目检索的 IPC）"
        testId="mgmt-memory-search"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[220px] flex-1 flex-col gap-0.5">
            <span className="text-subtle text-[var(--font-micro-size)]">查询（全文检索会话消息）</span>
            <input
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  search.run();
                }
              }}
              placeholder="例如：构建失败"
              data-testid="mgmt-memory-search-input"
              className={formInputClass}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-subtle text-[var(--font-micro-size)]">范围</span>
            <select
              value={search.workspaceScope}
              onChange={(event) => search.setWorkspaceScope(event.target.value === 'current' ? 'current' : 'all')}
              data-testid="mgmt-memory-search-scope"
              className={formInputClass}
            >
              <option value="all">全部工作目录</option>
              {/* `workspaceScope: 'current'` needs the backend's own hash; there is nothing to scope to until a directory is bound. */}
              <option value="current" disabled={files.memory.workspaceHash === null}>
                当前工作目录{files.memory.workspaceHash === null ? '（不可用）' : ''}
              </option>
            </select>
          </label>
          <button
            type="button"
            data-testid="mgmt-memory-search-run"
            disabled={search.status === 'loading' || search.query.trim().length === 0}
            onClick={() => search.run()}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Search size={11} aria-hidden="true" />
            {search.status === 'loading' ? '检索中…' : '检索'}
          </button>
        </div>
        {search.error === null ? null : (
          <FormNote tone="warn" testId="mgmt-memory-search-error">
            {search.error}
          </FormNote>
        )}
        {search.result === null ? (
          <FormNote testId="mgmt-memory-search-hint">
            检索的是持久化的会话消息（助手回复与提问答复）；用户提问本身不在检索面里（F17②）。
          </FormNote>
        ) : search.result.items.length === 0 ? (
          <FormNote testId="mgmt-memory-search-empty">没有命中（共 {search.result.total} 条）。</FormNote>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="mgmt-memory-search-hits">
            {search.result.items.map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5 rounded-card border border-line px-2 py-1">
                <span className="flex flex-wrap items-center gap-2 text-[var(--font-micro-size)]">
                  <span className="text-ink">{item.threadTitle ?? '(无标题会话)'}</span>
                  <span className="text-subtle">{item.role}</span>
                  <span className="text-subtle">{formatBeijingDateTime(item.createdAt)}</span>
                  <button
                    type="button"
                    data-testid={`mgmt-memory-search-open-${item.id}`}
                    onClick={() => scope.onOpenThread(item.threadId)}
                    className={`${formSecondaryButtonClass} ml-auto`}
                  >
                    打开会话
                  </button>
                </span>
                <span className="text-muted text-[var(--font-meta-size)]">{item.snippet}</span>
              </li>
            ))}
          </ul>
        )}
      </FormSection>

      <FormSection
        title={`自动沉淀审计（最近 ${memory.autoMemory.recent.length} 条）`}
        hint={`memory.status.autoMemory · 保留 ${memory.autoMemory.auditRetentionDays} 天 · ${memory.autoMemory.enabled ? '已启用' : '已停用'}`}
        testId="mgmt-memory-audit"
      >
        {memory.autoMemory.recent.length === 0 ? (
          <FormNote testId="mgmt-memory-audit-empty">
            还没有审计记录（自动记忆在设置中心的「记忆策略」里开关，见 P8）。
          </FormNote>
        ) : (
          <ul className="flex flex-col gap-0.5" data-testid="mgmt-memory-audit-list">
            {memory.autoMemory.recent.map((record) => (
              <li key={record.id} className="flex flex-col gap-0.5 text-[var(--font-micro-size)]">
                <span className="text-muted">{auditRecordLine(record)}</span>
                <span className="text-subtle">
                  {record.createdAt} · {record.reason}
                  {record.targetPath === null ? '' : ` · ${record.targetPath}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </FormSection>
    </div>
  );
}
