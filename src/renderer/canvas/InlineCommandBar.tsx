import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, MessageSquareText, PenLine, Search, X, type LucideIcon } from 'lucide-react';

export type InlineSelectionSource = 'workspace-file' | 'pdf';

export type InlineSelectionContext = {
  filePath: string;
  selectionText: string;
  lineRange: { start: number; end: number } | null;
  source: InlineSelectionSource;
  page?: number;
  documentId?: string;
};

export type InlineCommandAction = 'explain' | 'polish' | 'extract-citation' | 'send-to-assistant';

export type InlineSelectionAnchor = { x: number; y: number };

export type InlineReplacementProposal = {
  original: string;
  replacement: string;
  requestId?: string;
};

export type InlineCommandBarProps = {
  selection: InlineSelectionContext | null;
  anchor: InlineSelectionAnchor | null;
  onAction: (action: InlineCommandAction, selection: InlineSelectionContext) => void;
  onDismiss: () => void;
  onApplyReplacement?: (selection: InlineSelectionContext, replacement: string) => boolean;
  proposal?: InlineReplacementProposal | null;
  onAcceptProposal?: () => void;
  onRejectProposal?: () => void;
};

const actions: ReadonlyArray<{ id: InlineCommandAction; label: string; icon: LucideIcon }> = [
  { id: 'explain', label: '解释段落', icon: Search },
  { id: 'polish', label: '学术润色', icon: PenLine },
  { id: 'extract-citation', label: '提取引用', icon: FileText },
  { id: 'send-to-assistant', label: '发送到助手', icon: MessageSquareText }
];

/**
 * Small, selection-scoped command surface. It owns no navigation or agent state;
 * callers decide whether an action seeds a draft, starts a run, or requests a proposal.
 */
export function InlineCommandBar({
  selection,
  anchor,
  onAction,
  onDismiss,
  onApplyReplacement,
  proposal = null,
  onAcceptProposal,
  onRejectProposal
}: InlineCommandBarProps): React.JSX.Element | null {
  const firstAction = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState('');

  useEffect(() => {
    setEditing(false);
    setReplacement(selection?.selectionText ?? '');
  }, [selection]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null || anchor === null) return;
    const place = (): void => {
      const { width, height } = panel.getBoundingClientRect();
      // CSS keeps the inset current across viewport and theme changes; explicit
      // intrinsic width prevents positioning from changing shrink-to-fit width.
      panel.style.left = `clamp(var(--shadow-popover-gutter), ${anchor.x}px, calc(100vw - ${width}px - var(--shadow-popover-gutter)))`;
      panel.style.top = `clamp(var(--shadow-popover-gutter), ${anchor.y}px, calc(100dvh - ${height}px - var(--shadow-popover-gutter)))`;
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(panel);
    return () => resize.disconnect();
  }, [anchor, selection]);

  useEffect(() => {
    if (selection === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
      const active = document.activeElement;
      const inTextField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.getAttribute('contenteditable') === 'true';
      const inSelectionSurface = active instanceof Element && active.closest('[data-testid="latex-source-editor"], [data-testid="reader-pdf-text"]') !== null;
      const selectedDomText = window.getSelection()?.toString().trim() ?? '';
      if (inTextField && !inSelectionSurface) return;
      if (!inSelectionSurface && selectedDomText !== selection.selectionText.trim()) return;
      event.preventDefault();
      event.stopPropagation();
      firstAction.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [selection]);

  if (selection === null || selection.selectionText.trim().length === 0 || anchor === null) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="ui-scroll-region fixed z-40 flex w-max max-h-[calc(100dvh-2*var(--shadow-popover-gutter))] max-w-[min(560px,calc(100vw-2*var(--shadow-popover-gutter)))] flex-col gap-2 rounded-window border-[0.5px] border-line-default bg-surface-overlay p-2 text-ink-primary shadow-[var(--shadow-popover)]"
      role="toolbar"
      aria-label="文本选区命令"
      data-testid="inline-command-bar"
    >
      {proposal === null && !editing ? (
        <div className="flex flex-wrap items-center gap-1">
          {actions.map(({ id, label, icon: Icon }, index) => (
            <button
              key={id}
              ref={index === 0 ? firstAction : undefined}
              type="button"
              className="inline-flex min-h-8 items-center gap-1 rounded-control px-2 text-[length:var(--font-meta-size)] text-ink-secondary hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-focus-ring"
              onClick={() => onAction(id, selection)}
              data-testid={`inline-command-${id}`}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
            </button>
          ))}
          {onApplyReplacement === undefined ? null : <button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-control px-2 text-[length:var(--font-meta-size)] text-ink-secondary hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-focus-ring"
            onClick={() => { setReplacement(selection.selectionText); setEditing(true); }} data-testid="inline-command-edit-selection">
            <PenLine size={13} aria-hidden="true" />替换选区
          </button>}
          <button type="button" aria-label="关闭文本选区命令" title="关闭" className="ms-auto grid size-7 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-focus-ring" onClick={onDismiss}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : proposal !== null ? (
        <div className="min-w-0 p-1" data-testid="inline-command-proposal">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-[length:var(--font-meta-size)]">修改预览</span>
            <button type="button" aria-label="关闭修改预览" className="grid size-7 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-focus-ring" onClick={onRejectProposal}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="mt-1 max-h-44 overflow-auto rounded-control border-[0.5px] border-line-default bg-surface-base p-2 font-mono text-[length:var(--font-meta-size)] leading-6" dir="ltr">
            <div className="whitespace-pre-wrap text-[var(--st-bad)]" data-testid="inline-command-original">- {proposal.original}</div>
            <div className="whitespace-pre-wrap text-[var(--st-good)]" data-testid="inline-command-replacement">+ {proposal.replacement}</div>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="min-h-8 rounded-control border-[0.5px] border-line-default px-2 text-[length:var(--font-meta-size)] text-ink-secondary hover:bg-[var(--overlay-hover)] focus-visible:outline-2 focus-visible:outline-focus-ring" onClick={onRejectProposal} data-testid="inline-command-reject">取消</button>
            <button type="button" className="min-h-8 rounded-control border-[0.5px] border-line-default px-2 text-[length:var(--font-meta-size)] text-ink-primary hover:bg-[var(--overlay-hover)] focus-visible:outline-2 focus-visible:outline-focus-ring" onClick={onAcceptProposal} data-testid="inline-command-accept">应用到草稿</button>
          </div>
        </div>
      ) : (
        <div className="min-w-0 p-1" data-testid="inline-command-edit">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-[length:var(--font-meta-size)]">替换选区</span>
            <button type="button" aria-label="关闭选区替换" className="grid size-7 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-focus-ring" onClick={() => setEditing(false)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="mt-1 grid min-w-0 gap-2 text-[length:var(--font-meta-size)]">
            <div className="min-w-0 rounded-control border-[0.5px] border-line-default bg-surface-base p-2" dir="ltr">
              <span className="text-muted">原文</span>
              <div className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono" data-testid="inline-command-original">{selection.selectionText}</div>
            </div>
            <label className="grid min-w-0 gap-1">
              <span className="text-muted">替换为</span>
              <textarea value={replacement} onChange={event => setReplacement(event.target.value)} rows={3}
                className="min-h-16 min-w-0 resize-y rounded-control border-[0.5px] border-line-default bg-surface-base p-2 font-mono leading-6 text-ink-primary focus-visible:outline-2 focus-visible:outline-focus-ring"
                data-testid="inline-command-replacement-input" />
            </label>
            <div className="min-w-0 rounded-control border-[0.5px] border-line-default bg-surface-base p-2" dir="ltr">
              <span className="text-muted">预览</span>
              <div className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[var(--st-good)]" data-testid="inline-command-replacement">{replacement}</div>
            </div>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="min-h-8 rounded-control border-[0.5px] border-line-default px-2 text-[length:var(--font-meta-size)] text-ink-secondary hover:bg-[var(--overlay-hover)] focus-visible:outline-2 focus-visible:outline-focus-ring" onClick={() => setEditing(false)}>取消</button>
            <button type="button" className="min-h-8 rounded-control border-[0.5px] border-line-default px-2 text-[length:var(--font-meta-size)] text-ink-primary hover:bg-[var(--overlay-hover)] focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-50" disabled={replacement === selection.selectionText}
              onClick={() => { if (onApplyReplacement?.(selection, replacement)) { setEditing(false); onDismiss(); } }} data-testid="inline-command-apply-edit">应用到草稿</button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
