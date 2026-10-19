import { motion } from 'motion/react';
import { BookOpen, FileText, Terminal } from 'lucide-react';
import type { AppViewId } from '../app/routes';
import { tabIndicatorTransition } from '../shared/motion';

/**
 * Canvas: the primary tab strip plus the project views.
 *
 * The three top-level tabs are 文献 / LaTeX / 终端 — the new frontend's
 * information architecture, kept because they are the three surfaces a
 * researcher keeps open while working. Other views (总览 / 阶段 / 活动 / 溯源 /
 * 服务) are reached from the sidebar, the stage bar, or the chrome, so a tab is
 * only selected when the routed view is one of the three.
 *
 * Selection is therefore **derived from the URL**, not from component state: the
 * active tab is whichever of the three matches `?view=`.
 *
 * ## The indicator travels between tabs
 *
 * `research-studio` marks the active tab with `<motion.div layoutId
 * ="activeTabIndicator">` inside the button, so the underline *slides* when the
 * tab changes instead of blinking. P1 replaced that with a per-tab opacity
 * transition because the layout-projection engine cost ~385 KB in the eager
 * graph (1,075,296 B vs 690,349 B, everything else identical) against a 900 KB
 * self-imposed ceiling.
 *
 * That reasoning is now spent: P4–P9 finished at 917,865 B against the real
 * budget in `check-renderer-chunks.mjs` (1,700,000 B), so the projection engine
 * fits with room to spare, and `motion` is not on that script's deny-list. The
 * prototype's animation is restored, and the pinning is left in the gate rather
 * than in a comment. `MotionConfig reducedMotion="user"` still governs the
 * travel for reduced-motion users — the indicator then appears where it belongs
 * without sliding. The budget argument this comment used to make, and the
 * measurements that retired it, are recorded in
 * `docs/adr/0023-motion-parity-with-research-studio.md`.
 *
 * Icon hues are category identity, not decoration: they are the same four hues
 * `research-studio` writes inline (`text-sky-400` / `-amber-400` / `-emerald-400`),
 * exposed as `--icon-*` so no component carries a hex and the light theme can
 * drop to the 600 stops for contrast.
 */

export type CanvasTabId = Extract<AppViewId, 'literature' | 'latex' | 'terminal'>;

export type WorkspaceCanvasProps = {
  /** `null` when the routed view is not one of the three primary tabs. */
  activeTab: CanvasTabId | null;
  onTabChange: (tab: CanvasTabId) => void;
  /** Project views (`ViewContent`), or the portal placeholder. */
  children: React.ReactNode;
  /** Stage bar slot; P6 fills this. */
  stageBar?: React.ReactNode;
  /** Rendered at the right of the tab strip (project-scoped actions). */
  actions?: React.ReactNode;
};

const TABS: Array<{ id: CanvasTabId; label: string; icon: typeof BookOpen; iconClass: string }> = [
  { id: 'literature', label: '文献', icon: BookOpen, iconClass: 'text-[var(--icon-literature)]' },
  { id: 'latex', label: 'LaTeX', icon: FileText, iconClass: 'text-[var(--icon-latex)]' },
  { id: 'terminal', label: '终端', icon: Terminal, iconClass: 'text-[var(--icon-terminal)]' }
];

const TAB_BASE =
  'relative flex h-[30px] shrink-0 items-center gap-1.5 rounded-card border px-3 whitespace-nowrap text-[var(--font-meta-size)] transition-colors duration-[var(--duration-fast)]';

export function WorkspaceCanvas({
  activeTab,
  onTabChange,
  children,
  stageBar,
  actions
}: WorkspaceCanvasProps): React.JSX.Element {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === activeTab);
    const base = index < 0 ? 0 : index;
    const next = event.key === 'ArrowLeft' ? (base + TABS.length - 1) % TABS.length : (base + 1) % TABS.length;
    onTabChange(TABS[next]!.id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="canvas">
      <div
        role="tablist"
        aria-label="画布"
        onKeyDown={onKeyDown}
        className="no-scrollbar flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3"
      >
        {TABS.map((tab, index) => {
          const selected = tab.id === activeTab;
          const Icon = tab.icon;
          // With no primary tab selected (the default `overview` view), the
          // whole strip would otherwise be `tabIndex={-1}` and therefore
          // unreachable by keyboard. The first tab stays tabbable as the entry
          // point; roving focus takes over once a tab is selected.
          const tabbable = selected || (activeTab === null && index === 0);
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={tabbable ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              data-testid={`canvas-tab-${tab.id}`}
              className={
                selected
                  ? `${TAB_BASE} border-line-strong bg-surface font-semibold text-ink shadow-[var(--shadow-card)]`
                  : `${TAB_BASE} border-transparent text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]`
              }
            >
              <Icon size={13} aria-hidden="true" className={tab.iconClass} />
              <span>{tab.label}</span>
              {selected ? (
                // `layoutId` is shared across the three tabs, so React mounts one
                // indicator at a time and motion interpolates its box — the slide.
                <motion.div
                  aria-hidden="true"
                  data-testid="canvas-tab-indicator"
                  layoutId="canvas-active-tab-indicator"
                  transition={tabIndicatorTransition}
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent"
                />
              ) : null}
            </button>
          );
        })}
        {actions === undefined ? null : <div className="ml-auto flex shrink-0 items-center gap-1 py-1">{actions}</div>}
      </div>

      {stageBar === undefined ? null : <div className="shrink-0">{stageBar}</div>}

      {/* Single scroll surface for the canvas (MASTER v2 §5). */}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
