import { useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { OVERLAY_Z_INDEX } from '../shell/overlay-stack';
import { ResizableDivider } from '../shell/ResizableDivider';
import { OverlayFocusRestore, useOverlayBehavior } from '../shell/use-overlay-behavior';
import { ViewActivity } from '../shared/view-activity';
import { ASSISTANT_WIDTH, SIDEBAR_WIDTH } from './ui-state';
import { ACTIVITY_RAIL_WIDTH, type LayoutPersistence } from './useLayoutPersistence';

function WorkspacePane({ open, floating, inactive = false, side, title, testId, trigger, width, onClose, children, ownHeader = false }: {
  open: boolean;
  floating: boolean;
  inactive?: boolean;
  side: 'start' | 'end';
  title: string;
  testId: string;
  trigger?: string;
  width: string;
  onClose: () => void;
  children: ReactNode;
  ownHeader?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const id = useId();
  useOverlayBehavior({
    open: open && floating, panelRef: ref, onRequestClose: onClose, canClose: () => true,
    overlayId: id, layer: 'ambient', inertBackground: false, preserveFocus: ownHeader
  });
  return <aside ref={ref} data-testid={open ? `${testId}-${floating ? 'drawer' : 'column'}` : undefined} aria-label={title}
    role={floating ? 'dialog' : undefined} hidden={!open} inert={!open || inactive}
    className={`${open ? 'flex' : 'hidden'} min-h-0 min-w-0 shrink-0 flex-col ${floating ? 'absolute inset-y-0 bg-surface-overlay' : 'bg-surface-rail'}`}
    style={floating ? {
      width, maxWidth: `calc(100% - ${ACTIVITY_RAIL_WIDTH + 32}px)`, zIndex: OVERLAY_Z_INDEX.ambient + 1,
      ...(side === 'start' ? { insetInlineStart: ACTIVITY_RAIL_WIDTH } : { insetInlineEnd: 0 })
    } : { width }}>
    {open && floating ? <>
      <OverlayFocusRestore returnFocusSelector={trigger === undefined ? undefined : `[data-testid="${trigger}"]`}
        restoreWhen={() => !ownHeader || !openRef.current || !ref.current?.isConnected} />
      {ownHeader ? null : <header className="flex h-10 shrink-0 items-center justify-between border-b-[0.5px] border-line px-3">
        <span className="font-medium">{title}</span>
        <button type="button" aria-label={`关闭${title}`} title={`关闭${title} (Esc)`} data-testid={`${testId}-drawer-close`}
          onClick={onClose} className="grid size-7 place-items-center rounded-control text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]">
          <X size={16} aria-hidden="true" />
        </button>
      </header>}
    </> : null}
    <ViewActivity active={open && !inactive}>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </ViewActivity>
  </aside>;
}

export function WorkspaceLayout({ layout, assistantOpen, onCloseAssistant, activityRail, contextDrawer, canvas, assistant,
  inspector, inspectorOpen = false, onCloseInspector }: {
  layout: LayoutPersistence;
  assistantOpen: boolean;
  onCloseAssistant: () => void;
  activityRail: ReactNode;
  contextDrawer: ReactNode;
  canvas: ReactNode;
  assistant: ReactNode;
  inspector?: ReactNode;
  inspectorOpen?: boolean;
  /** Must use the artifact-change guard; Escape and the narrow-pane scrim use this entry. */
  onCloseInspector?: () => void;
}): React.JSX.Element {
  const { drawerFloating, assistantFloating } = layout;
  const drawerOverlay = drawerFloating && layout.drawerOpen;
  const inspectorVisible = inspectorOpen && !(assistantFloating && drawerOverlay);
  const assistantVisible = assistantOpen && !inspectorOpen && !(assistantFloating && drawerOverlay);
  const rightVisible = assistantVisible || inspectorVisible;
  const rightOverlay = assistantFloating && rightVisible;
  const closeRight = inspectorOpen ? () => onCloseInspector?.() : onCloseAssistant;
  const closeDrawer = (): void => layout.setDrawerOpen(false);
  return <div className="relative flex min-h-0 min-w-0 flex-1" data-testid="workspace-layout"
    data-layout-mode={layout.mode} data-layout-preset={layout.preset}
    style={{ '--drawer-w': `${layout.drawerWidth}px`, '--assistant-w': `${layout.assistantWidth}px` } as CSSProperties}>
    {activityRail}
    <WorkspacePane open={layout.drawerOpen} floating={drawerFloating} inactive={rightOverlay} side="start" title="项目上下文"
      testId="sidebar" trigger="titlebar-toggle-sidebar" width="var(--drawer-w)" onClose={closeDrawer}>
      {contextDrawer}
    </WorkspacePane>
    {!drawerFloating && layout.drawerOpen ? <ResizableDivider ariaLabel="调整左栏宽度" value={layout.drawerWidth}
      min={SIDEBAR_WIDTH.min} max={SIDEBAR_WIDTH.max} onResize={layout.resizeDrawer} onReset={layout.resetDrawer}
      testId="divider-sidebar" /> : null}
    <main id="roc-main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col" data-testid="canvas-column"
      inert={drawerOverlay || rightOverlay}>
      {canvas}
    </main>
    {!assistantFloating && rightVisible && !drawerOverlay ? <ResizableDivider ariaLabel={inspectorOpen ? '调整检视区宽度' : '调整助手宽度'} value={layout.assistantWidth}
      min={ASSISTANT_WIDTH.min} max={layout.assistantMaxWidth} onResize={layout.resizeAssistant} onReset={layout.resetAssistant}
      growToward="start" testId={inspectorOpen ? 'divider-inspector' : 'divider-assistant'} /> : null}
    <WorkspacePane open={assistantVisible} floating={assistantFloating} inactive={drawerOverlay} side="end" title="研究助手"
      testId="assistant" trigger="titlebar-toggle-assistant" width="var(--assistant-w)" onClose={onCloseAssistant}>
      {assistant}
    </WorkspacePane>
    <WorkspacePane open={inspectorVisible} floating={assistantFloating} inactive={drawerOverlay} side="end" title="工件检视"
      testId="inspector" width="var(--assistant-w)" onClose={closeRight} ownHeader>
      {inspector}
    </WorkspacePane>
    {drawerOverlay || rightOverlay ? <div aria-hidden="true" className="absolute inset-y-0 end-0 bg-[var(--overlay-scrim)]"
      style={{ insetInlineStart: ACTIVITY_RAIL_WIDTH, zIndex: OVERLAY_Z_INDEX.ambient }} onClick={drawerOverlay ? closeDrawer : closeRight} /> : null}
  </div>;
}
