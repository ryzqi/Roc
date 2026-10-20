import { ModalShell } from '../shell/ModalShell';
import { ResizableDivider } from '../shell/ResizableDivider';
import { ASSISTANT_WIDTH, SIDEBAR_WIDTH } from './ui-state';
import type { LayoutState } from './use-layout-state';

/**
 * Three-column workspace layout: sidebar | assistant | canvas.
 *
 * Extracted from `AppShell` so the geometry rules live in one place and can be
 * reasoned about without the boot/routing/overlay concerns. Widths arrive as CSS
 * variables on the container (`--sidebar-w`, `--assistant-w`) because they are
 * dynamic; colors still come only from the token layer.
 *
 * **Column order is 左栏 | 助手 | 画布** (ADR 0023): sidebar, divider, assistant column,
 * divider, canvas — so the assistant sits *between* the rail and the canvas and the
 * canvas owns the right edge. This is the arrangement a researcher resizes while
 * writing: the canvas keeps `flex-1` and stays the widest surface, and dragging the
 * assistant's divider right grows the assistant.
 *
 * At `<= 1099px` the sidebar and assistant become drawers instead of
 * columns. The window's own minimum is 1184px, so that mode mainly exists for
 * the layout audit and for a future lower minimum — it is implemented rather
 * than left as a TODO so the canvas never collapses if it is reached.
 */

export type WorkspaceLayoutProps = {
  layout: LayoutState;
  /** From the URL (`?assistant=1`), not from layout state. */
  assistantOpen: boolean;
  onToggleSidebar: () => void;
  onToggleAssistant: () => void;
  sidebar: React.ReactNode;
  canvas: React.ReactNode;
  assistant: React.ReactNode;
  /** Assistant is only meaningful inside a project. */
  assistantAvailable: boolean;
};

export function WorkspaceLayout({
  layout,
  assistantOpen,
  onToggleSidebar,
  onToggleAssistant,
  sidebar,
  canvas,
  assistant,
  assistantAvailable
}: WorkspaceLayoutProps): React.JSX.Element {
  const sidebarVisible = !layout.sidebarCollapsed && !layout.sidebarAsDrawer;
  const assistantVisible = assistantAvailable && assistantOpen && !layout.assistantAsDrawer;

  // Report the clamp state so the divider can announce why dragging stopped,
  // instead of the handle silently refusing to move.
  const sidebarAtLimit =
    layout.sidebarWidth <= SIDEBAR_WIDTH.min ? 'min' : layout.sidebarWidth >= SIDEBAR_WIDTH.max ? 'max' : null;
  const assistantAtLimit = layout.assistantWidth <= ASSISTANT_WIDTH.min ? 'min' : null;

  return (
    <div
      className="flex min-h-0 flex-1"
      data-testid="workspace-layout"
      data-layout-mode={layout.mode}
      style={
        {
          '--sidebar-w': `${layout.sidebarWidth}px`,
          '--assistant-w': `${layout.assistantWidth}px`
        } as React.CSSProperties
      }
    >
      {sidebarVisible ? (
        <>
          <div className="flex w-[var(--sidebar-w)] shrink-0 flex-col" data-testid="sidebar-column">
            {sidebar}
          </div>
          <ResizableDivider
            ariaLabel="调整左栏宽度"
            onDelta={layout.growSidebar}
            onReset={layout.resetSidebar}
            atLimit={sidebarAtLimit}
            testId="divider-sidebar"
          />
        </>
      ) : null}

      {assistantVisible ? (
        <>
          <div className="flex w-[var(--assistant-w)] shrink-0 flex-col" data-testid="assistant-column">
            {assistant}
          </div>
          {/* The divider is *after* the assistant, which is what makes dragging it right
              widen the panel (see `growAssistant`). */}
          <ResizableDivider
            ariaLabel="调整助手宽度"
            onDelta={layout.growAssistant}
            onReset={layout.resetAssistant}
            atLimit={assistantAtLimit}
            testId="divider-assistant"
          />
        </>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col" data-testid="canvas-column">
        {canvas}
      </main>

      {layout.sidebarAsDrawer && !layout.sidebarCollapsed && assistantAvailable ? (
        <ModalShell
          open
          kind="drawer"
          title="项目上下文"
          onClose={onToggleSidebar}
          widthClassName="w-[360px]"
          testId="sidebar-drawer"
        >
          {sidebar}
        </ModalShell>
      ) : null}

      {layout.assistantAsDrawer && assistantAvailable && assistantOpen ? (
        <ModalShell
          open
          kind="drawer"
          title="研究助手"
          onClose={onToggleAssistant}
          widthClassName="w-[520px]"
          testId="assistant-drawer"
        >
          {assistant}
        </ModalShell>
      ) : null}
    </div>
  );
}
