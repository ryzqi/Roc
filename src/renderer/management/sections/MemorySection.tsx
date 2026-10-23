import { Suspense, lazy, useId, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, FileText, History, Info, Pencil, RefreshCw, Search } from 'lucide-react';
import { formatBeijingDateTime } from '../../shared/format';
import { FormNote, KeyValueRow, formInputClass, formSecondaryButtonClass, formTextAreaClass } from '../../shared/form-ui';
import type { ManagementScope } from '../management-scope';
import { autoMemoryActionLabels, autoMemoryTypeLabels, capacityLabel, codePointCount, buildMemoryAssistPrompt, slotUnavailableReason, snapshotIncludesSlot } from '../memory-model';
import { useMemorySnapshot, useSessionSearch, type MemoryFilesStore } from '../use-memory';
import './memory-section.css';

const MarkdownView = lazy(async () => ({ default: (await import('../../assistant/blocks/markdown-view')).MarkdownView }));
type MemoryTool = 'audit' | 'preview' | 'search' | 'details';

/** Reading and editing share the same five backend slots. Only category identity is persisted. */
export function MemorySection({ scope, store: files }: { scope: ManagementScope; store: MemoryFilesStore }): React.JSX.Element {
  const instanceId = useId();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [tool, setTool] = useState<MemoryTool | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const selectedKey = `${files.selected.scope}:${files.selected.kind}`;
  const editing = editingKey === selectedKey;
  const selectedMeta = files.rows.find(({ slot }) => slot.scope === files.selected.scope && slot.kind === files.selected.kind)?.meta ?? null;
  const writable = selectedMeta?.effective === true;
  const dirty = files.dirty(files.selected);
  const finishEditing = (): void => {
    setEditingKey(null);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };
  const save = (): void => {
    void files.save.run().then((saved) => {
      if (saved) {
        setPreviewRevision((current) => current + 1);
        finishEditing();
      }
    });
  };

  if (files.memory === null) {
    return <FormNote tone={files.status === 'error' ? 'warn' : 'default'} testId={files.status === 'error' ? 'mgmt-memory-error' : 'mgmt-memory-loading'}>
      {files.status === 'error' ? `读取记忆状态失败：${files.error}` : '正在读取记忆…'}
    </FormNote>;
  }

  const memory = files.memory;
  const unavailable = slotUnavailableReason(selectedMeta, files.selected);
  return (
    <div className="memory-page" data-testid="mgmt-memory">
      <header className="memory-page-heading">
        <div><h2>记忆</h2><p>助手长期保留的信息，可查看和修改</p></div>
        <button type="button" data-testid="mgmt-memory-reload" disabled={files.status === 'loading' || files.save.pending} onClick={files.reload} className={formSecondaryButtonClass} aria-label="重新读取记忆状态" title="重新读取记忆状态">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </header>
      {files.status === 'error' ? <FormNote tone="warn">刷新失败：{files.error}</FormNote> : null}
      <div className="memory-layout" data-testid="mgmt-memory-files">
        <nav className="memory-navigation" aria-label="记忆分类" data-testid="mgmt-memory-slots">
          {(['workspace', 'global'] as const).map((group) => (
            <div className="memory-navigation-group" key={group}>
              <h3>{group === 'workspace' ? '当前项目' : '全局'}</h3>
              {[...files.rows].filter(({ slot }) => slot.scope === group).sort((a, b) => group === 'workspace' ? Number(b.slot.kind === 'memory') - Number(a.slot.kind === 'memory') : 0).map(({ slot, meta }) => {
                const selected = slot.scope === files.selected.scope && slot.kind === files.selected.kind;
                const pending = files.dirty(slot);
                return <button key={slot.kind} type="button" aria-current={selected ? 'page' : undefined} disabled={files.save.pending || (slot.requiresWorkspace && memory.workspaceHash === null)}
                  data-testid={`mgmt-memory-slot-${slot.scope}-${slot.kind}`} data-dirty={pending ? 'true' : 'false'} title={slot.requiresWorkspace && memory.workspaceHash === null ? '打开项目后可查看' : slot.purpose}
                  onClick={() => { setEditingKey(null); files.selectSlot(slot.scope, slot.kind); }}>
                  <span>{slot.label}</span>
                  {pending ? <span className="memory-draft-indicator"><AlertTriangle size={11} aria-hidden="true" /><span className="sr-only">未保存</span></span> : meta?.exists === false ? <span className="memory-empty-indicator">空</span> : null}
                </button>;
              })}
            </div>
          ))}
          {memory.workspaceHash === null ? <p className="memory-navigation-hint">打开项目后可查看项目记忆</p> : null}
        </nav>
        <section className="memory-document" aria-labelledby={`${instanceId}-title`} data-testid="mgmt-memory-document">
          <header className="memory-document-heading">
            <div><h3 id={`${instanceId}-title`}>{files.selected.label}</h3><p>{files.selected.purpose}</p><span className="memory-scope">{files.selected.scope === 'workspace' ? `仅适用于 ${memory.workspaceLabel ?? '当前项目'}` : '适用于所有项目'}</span></div>
            <button ref={editButtonRef} type="button" data-testid="mgmt-memory-edit" hidden={editing} disabled={!writable || files.contentLoading || files.contentError !== null} onClick={() => setEditingKey(selectedKey)} className={formSecondaryButtonClass}>
              <Pencil size={12} aria-hidden="true" />{dirty ? '继续编辑' : '编辑'}
            </button>
          </header>
          {files.contentError !== null ? <FormNote tone="warn" testId="mgmt-memory-content-error">读取内容失败：{files.contentError}</FormNote> : null}
          {unavailable === null ? null : <FormNote tone="warn" testId="mgmt-memory-slot-unavailable">{unavailable}</FormNote>}
          {files.save.outcome === null ? null : <div role="status"><FormNote tone={files.save.outcome.status === 'saved' ? 'default' : 'warn'} testId="mgmt-memory-outcome">
            {files.save.outcome.status === 'saved' ? <span className="memory-inline"><Check size={12} aria-hidden="true" />已保存</span> : `未保存：${files.save.outcome.message}`}
            {files.save.outcome.issues.length > 0 ? ` · 命中：${files.save.outcome.issues.map((issue) => `${issue.category}(${issue.pattern})`).join('、')}` : null}
          </FormNote></div>}
          {files.save.error === null ? null : <FormNote tone="warn" testId="mgmt-memory-save-error">{files.save.error}</FormNote>}
          {files.contentLoading ? <FormNote>正在读取内容…</FormNote> : files.contentError !== null ? null : editing ? (
            <div className="memory-editor" data-testid="mgmt-memory-editor" onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && dirty && !files.save.pending) { event.preventDefault(); save(); }
              if (event.key === 'Escape' && !dirty && !files.save.pending) { event.stopPropagation(); finishEditing(); }
            }}>
              <label className="sr-only" htmlFor={`${instanceId}-editor`}>编辑{files.selected.label}</label>
              <textarea id={`${instanceId}-editor`} ref={textareaRef} autoFocus value={files.draft} rows={16} spellCheck={false} disabled={files.save.pending} onChange={(event) => files.setDraft(event.target.value)} data-testid="mgmt-memory-textarea" className={formTextAreaClass} />
              <div className="memory-editor-actions">
                <button type="button" data-testid="mgmt-memory-save" disabled={!writable || !dirty || files.save.pending} onClick={save} className={formSecondaryButtonClass}>{files.save.pending ? '保存中…' : '保存'}</button>
                <button type="button" data-testid="mgmt-memory-discard" disabled={files.save.pending} onClick={() => { files.discard(); finishEditing(); }} className={formSecondaryButtonClass}>取消</button>
                <span data-testid="mgmt-memory-length">{codePointCount(files.draft).toLocaleString('en-US')} / {selectedMeta?.charLimit.toLocaleString('en-US') ?? '—'} 字符</span>
                <button type="button" data-testid="mgmt-memory-assist" disabled={files.save.pending} onClick={() => scope.onAskAssistant(buildMemoryAssistPrompt(files.selected, files.draft))} className={formSecondaryButtonClass}><Bot size={12} aria-hidden="true" />请助手整理</button>
              </div>
              <p className="memory-editor-hint">支持 Markdown · ⌘ Enter 保存</p>
            </div>
          ) : (
            <>
              {dirty ? <div className="memory-unsaved-note" role="status"><AlertTriangle size={12} aria-hidden="true" />此分类有未保存的修改，正在展示已保存的内容。<button type="button" onClick={() => setEditingKey(selectedKey)}>继续编辑</button></div> : null}
              {(files.content ?? '').trim().length === 0 ? <div className="memory-empty" data-testid="mgmt-memory-empty"><FileText size={25} strokeWidth={1.25} aria-hidden="true" /><h4>还没有{files.selected.label}</h4><p>以后保留在这里的信息会显示在此处。</p>{writable ? <button type="button" data-testid="mgmt-memory-add" onClick={() => setEditingKey(selectedKey)} className={formSecondaryButtonClass}>添加内容</button> : null}</div> :
                <div className="memory-reading" data-testid="mgmt-memory-reading"><Suspense fallback={<FormNote>正在排版记忆…</FormNote>}><MarkdownView text={files.content ?? ''} /></Suspense></div>}
              {selectedMeta?.updatedAt == null ? null : <p className="memory-updated">最近更新于 {formatBeijingDateTime(selectedMeta.updatedAt)}</p>}
            </>
          )}
        </section>
      </div>
      <footer className="memory-tools" aria-label="记忆辅助工具">
        {([{ id: 'audit', label: '最近变更', icon: History }, { id: 'preview', label: '生效内容预览', icon: FileText }, { id: 'search', label: '从会话中查找', icon: Search }, { id: 'details', label: '详情', icon: Info }] as const).map(({ id, label, icon: Icon }) =>
          <button key={id} type="button" aria-expanded={tool === id} aria-controls={`${instanceId}-tool-${id}`} data-testid={`mgmt-memory-${id === 'preview' ? 'preview-toggle' : `${id}-toggle`}`} onClick={() => setTool((current) => current === id ? null : id)}><Icon size={13} aria-hidden="true" />{label}</button>
        )}
      </footer>
      {tool === null ? null : <div className="memory-tool-panel" id={`${instanceId}-tool-${tool}`}>
        <MemoryToolPanel key={tool} tool={tool} scope={scope} files={files} previewRevision={previewRevision} />
      </div>}
    </div>
  );
}

function MemoryToolPanel({ tool, scope, files, previewRevision }: { tool: MemoryTool; scope: ManagementScope; files: MemoryFilesStore; previewRevision: number }): React.JSX.Element | null {
  const memory = files.memory;
  if (memory === null) return null;
  if (tool === 'preview') return <MemoryPreview scope={scope} files={files} revision={previewRevision} />;
  if (tool === 'search') return <MemorySessionSearch scope={scope} files={files} />;
  if (tool === 'audit') return <section data-testid="mgmt-memory-audit"><h3>最近变更</h3><p className="memory-tool-description">助手自动整理记忆的最近记录</p>
    {memory.autoMemory.recent.length === 0 ? <FormNote>还没有自动整理记录。</FormNote> : <ul className="memory-audit-list" data-testid="mgmt-memory-audit-list">{memory.autoMemory.recent.map((record) => <li key={record.id}>
      <p>{record.summary}</p><div className="memory-audit-meta"><span>{autoMemoryActionLabels[record.action]}</span><span>{formatBeijingDateTime(record.createdAt)}</span></div>
      <details><summary>处理详情</summary><p>{autoMemoryTypeLabels[record.type]} · {record.reason}</p>{record.targetPath === null ? null : <code>{record.targetPath}</code>}</details>
    </li>)}</ul>}
  </section>;
  return <section data-testid="mgmt-memory-details"><h3>记忆详情</h3><dl>
    <KeyValueRow label="存储位置" value={memory.root} testId="mgmt-memory-root" />
    <KeyValueRow label="工作目录" value={memory.workspaceLabel ?? '未绑定'} testId="mgmt-memory-workspace" />
    <KeyValueRow label="生效预览" value={`${memory.snapshot.enabled ? '启用' : '停用'} · ${memory.snapshot.totalChars} / ${memory.snapshot.totalLimit} 字符`} testId="mgmt-memory-snapshot-state" />
    <KeyValueRow label="会话消息" value={`${memory.sessionMessages.totalRows} 行 · 保留 ${memory.sessionMessages.retentionDays} 天 · 最早 ${memory.sessionMessages.oldestAt === null ? '—' : formatBeijingDateTime(memory.sessionMessages.oldestAt)}`} testId="mgmt-memory-sessions" />
    <KeyValueRow label="全文索引" value={memory.fullTextIndex.healthy ? '健康' : '异常（会话检索可能无结果）'} testId="mgmt-memory-index" />
    {files.rows.map(({ slot, meta }) => <KeyValueRow key={slot.virtualPath} label={slot.label} value={`${slot.virtualPath} · ${capacityLabel(meta)}`} testId={`mgmt-memory-capacity-${slot.scope}-${slot.kind}`} />)}
  </dl></section>;
}

function MemoryPreview({ scope, files, revision }: { scope: ManagementScope; files: MemoryFilesStore; revision: number }): React.JSX.Element {
  const preview = useMemorySnapshot(scope.client, revision);
  return <section data-testid="mgmt-memory-preview"><h3>生效内容预览</h3><p className="memory-tool-description">按当前配置生成下一次对话的记忆预览，可能与保存的完整内容不同。</p>
    {preview.error !== null ? <FormNote tone="warn" testId="mgmt-memory-preview-error">{preview.error}</FormNote> : preview.status === 'loading' ? <FormNote>正在读取预览…</FormNote> : <>
      <p className="memory-tool-description" data-testid="mgmt-memory-preview-count">{preview.charCount} 字符 · {snapshotIncludesSlot(preview.text ?? '', files.selected) ? '包含当前分类' : '未包含当前分类（内容为空或未生效）'}</p>
      <pre data-testid="mgmt-memory-preview-text">{preview.text || '当前没有可带入的记忆。'}</pre>
    </>}
  </section>;
}

function MemorySessionSearch({ scope, files }: { scope: ManagementScope; files: MemoryFilesStore }): React.JSX.Element {
  const search = useSessionSearch(scope.client, files.memory?.workspaceHash ?? null);
  return <section data-testid="mgmt-memory-search"><h3>从会话中查找</h3><p className="memory-tool-description">查找历史对话中的信息，结果不代表已保存为记忆。</p>
    <form className="memory-search-form" onSubmit={(event) => { event.preventDefault(); search.run(); }}>
      <label><span className="sr-only">查找会话内容</span><input value={search.query} onChange={(event) => search.setQuery(event.target.value)} placeholder="输入要查找的内容" data-testid="mgmt-memory-search-input" className={formInputClass} /></label>
      <label><span className="sr-only">查找范围</span><select value={search.workspaceScope} onChange={(event) => search.setWorkspaceScope(event.target.value === 'current' ? 'current' : 'all')} data-testid="mgmt-memory-search-scope" className={formInputClass}><option value="all">全部项目</option><option value="current" disabled={files.memory?.workspaceHash == null}>当前项目{files.memory?.workspaceHash == null ? '（不可用）' : ''}</option></select></label>
      <button type="submit" data-testid="mgmt-memory-search-run" disabled={search.status === 'loading' || search.query.trim().length === 0} className={formSecondaryButtonClass}><Search size={12} aria-hidden="true" />{search.status === 'loading' ? '查找中…' : '查找'}</button>
    </form>
    {search.error === null ? null : <FormNote tone="warn" testId="mgmt-memory-search-error">{search.error}</FormNote>}
    {search.result === null ? null : search.result.items.length === 0 ? <FormNote testId="mgmt-memory-search-empty">没有找到相关会话。</FormNote> : <ul className="memory-search-results" data-testid="mgmt-memory-search-hits">{search.result.items.map((item) => <li key={item.id}><div><strong>{item.threadTitle ?? '无标题会话'}</strong><span>{formatBeijingDateTime(item.createdAt)}</span><button type="button" data-testid={`mgmt-memory-search-open-${item.id}`} onClick={() => scope.onOpenThread(item.threadId)} className={formSecondaryButtonClass}>打开会话</button></div><p>{item.snippet}</p></li>)}</ul>}
  </section>;
}
