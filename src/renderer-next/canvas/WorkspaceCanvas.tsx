import type { AppViewId } from '../app/routes';

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
 * ## Why the indicator is a CSS transition, not `motion`'s `layoutId`
 *
 * A shared-layout indicator costs ~385 KB of eager JS (measured: 1,075,296 B
 * with `motion.div layoutId` vs 690,349 B without, everything else identical),
 * because it pulls in the whole layout-projection engine. That is 22% of the
 * `check-renderer-chunks` budget for one sliding underline, and P4/P5 still need
 * headroom for the Markdown and KaTeX families (R4 / ADR-M11). AGENTS.md's
 * "do not introduce animation without a functional purpose" settles it.
 *
 * The replacement is a 120ms opacity/scale transition on the selected tab's own
 * underline. It communicates the same state change, costs nothing, and is
 * neutralised by the global `prefers-reduced-motion` rule in
 * `styles/index.css`. `MotionConfig reducedMotion="user"` stays mounted
 * (~2 KB) for any future animation that genuinely needs it.
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

const TABS: Array<{ id: CanvasTabId; label: string }> = [
  { id: 'literature', label: '文献' },
  { id: 'latex', label: 'LaTeX' },
  { id: 'terminal', label: '终端' }
];

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
        className="flex shrink-0 items-center gap-0.5 border-b border-line px-2"
      >
        {TABS.map((tab, index) => {
          const selected = tab.id === activeTab;
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
                  ? 'relative h-9 rounded-control px-2.5 text-ink active:bg-[var(--overlay-active)]'
                  : 'relative h-9 rounded-control px-2.5 text-muted hover:text-ink active:bg-[var(--overlay-active)]'
              }
            >
              {selected ? (
                <span
                  aria-hidden="true"
                  data-testid="canvas-tab-indicator"
                  className="absolute inset-x-1.5 -bottom-px h-0.5 origin-center rounded-full bg-accent transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-soft)] motion-reduce:transition-none"
                />
              ) : null}
              <span className="text-[var(--font-meta-size)]">{tab.label}</span>
            </button>
          );
        })}
        {actions === undefined ? null : <div className="ml-auto flex items-center gap-1 py-1">{actions}</div>}
      </div>

      {stageBar === undefined ? null : <div className="shrink-0">{stageBar}</div>}

      {/* Single scroll surface for the canvas (MASTER v2 §5). */}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
