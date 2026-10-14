import { useRef, useState } from 'react';
import { ModalShell } from '../shell/ModalShell';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { EmptyState } from '../shell/EmptyState';

/**
 * Settings overlay shell (P1). Sections land in P8.
 *
 * Fixed shape from MASTER v2 §6.7: `min(1100px, 92vw)` x `min(86vh, 760px)`,
 * a 220px section list with 40px rows, and a dirty bar pinned at the top that
 * states how many fields changed. The section order is normative — P8 fills the
 * bodies, and reordering here is a MASTER change.
 *
 * P1 wires open/close, Escape, focus return, the draft-veto hook and the dirty
 * indicator; every section body is a placeholder until P8.
 */

export type SettingsSectionId =
  | 'models'
  | 'default-model'
  | 'rag'
  | 'literature'
  | 'sandbox'
  | 'guardrail'
  | 'app'
  | 'tasks'
  | 'authorization'
  | 'hooks'
  | 'memory'
  | 'backup';

const SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: 'models', label: '模型与服务' },
  { id: 'default-model', label: '默认模型' },
  { id: 'rag', label: '向量与 RAG' },
  { id: 'literature', label: '文献与解析' },
  { id: 'sandbox', label: '编译与沙箱' },
  { id: 'guardrail', label: '智能体安全' },
  { id: 'app', label: '应用基础' },
  { id: 'tasks', label: '任务与调度' },
  { id: 'authorization', label: '授权与安全' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'memory', label: '记忆策略' },
  { id: 'backup', label: '偏好与备份' }
];

const SECTION_PHASE: Record<SettingsSectionId, string> = {
  models: 'P8 实现',
  'default-model': 'P8 实现',
  rag: 'P8 实现',
  literature: 'P8 实现',
  sandbox: 'P8 实现',
  guardrail: 'P8 实现',
  app: 'P8 实现',
  tasks: 'P8 实现',
  authorization: 'P9 实现',
  hooks: 'P8 实现',
  memory: 'P9 实现',
  backup: 'P8 实现'
};

export type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
  /** Number of unsaved fields; drives the dirty bar and the close confirmation. */
  dirtyCount?: number;
  onSave?: () => void;
  onDiscard?: () => void;
};

export function SettingsModal({
  open,
  onClose,
  dirtyCount = 0,
  onSave,
  onDiscard
}: SettingsModalProps): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('models');
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const dirty = dirtyCount > 0;

  // Unsaved drafts are never discarded silently: the veto opens a confirmation
  // instead of closing, and Escape cancels it (MASTER v2 §6.7 / §11).
  const requestClose = (): boolean => {
    if (!dirty) {
      return true;
    }
    setCloseConfirmOpen(true);
    return false;
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const index = SECTIONS.findIndex((section) => section.id === activeSection);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]!;
    setActiveSection(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-section="${next.id}"]`)?.focus();
  };

  return (
    <>
      <ModalShell
        open={open}
        title="设置"
        onClose={onClose}
        beforeClose={requestClose}
        widthClassName="w-[min(1100px,92vw)]"
        testId="settings-modal"
      >
      <div className="flex h-[min(86vh,760px)] gap-3">
        <div
          ref={listRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label="设置分区"
          onKeyDown={onListKeyDown}
          className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line pr-2"
        >
          {SECTIONS.map((section) => {
            const selected = section.id === activeSection;
            return (
              <button
                key={section.id}
                type="button"
                role="tab"
                data-section={section.id}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveSection(section.id)}
                data-testid={`settings-section-${section.id}`}
                className={
                  selected
                    ? 'flex h-10 items-center rounded-control bg-accent-soft px-2.5 text-left text-ink active:bg-[var(--accent-soft-strong)]'
                    : 'flex h-10 items-center rounded-control px-2.5 text-left text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                }
              >
                <span className="text-[var(--font-meta-size)]">{section.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line pb-2">
            <span className="min-w-0 flex-1 text-muted text-[var(--font-meta-size)]" data-testid="settings-dirty-bar">
              {dirty ? `未保存 ${dirtyCount} 项` : '没有未保存的改动'}
            </span>
            <button
              type="button"
              onClick={onDiscard}
              disabled={!dirty}
              className="h-[var(--control-height-compact)] rounded-control px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
            >
              放弃修改
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty}
              className="h-[var(--control-height-compact)] rounded-control border border-line bg-surface-strong px-3 text-ink hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40"
            >
              保存设置
            </button>
          </div>

          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto pt-3" data-testid="settings-panel">
            <EmptyState
              title={SECTIONS.find((section) => section.id === activeSection)?.label ?? ''}
              description="该分区尚未接入后端设置。配置的唯一可写位置是这里（MASTER v2 §7）。"
              testId={`settings-placeholder-${activeSection}`}
            />
            <p className="px-6 text-center text-subtle text-[var(--font-micro-size)]">
              {SECTION_PHASE[activeSection]}
            </p>
          </div>
        </div>
      </div>
      </ModalShell>

      <ConfirmDialog
        open={closeConfirmOpen}
        title="放弃未保存的设置？"
        message={`有 ${dirtyCount} 项设置尚未保存。`}
        detail="放弃后这些改动不会写入后端，需要重新设置。"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        tone="destructive"
        testId="settings-discard"
        onCancel={() => setCloseConfirmOpen(false)}
        onConfirm={() => {
          setCloseConfirmOpen(false);
          onDiscard?.();
          onClose();
        }}
      />
    </>
  );
}
