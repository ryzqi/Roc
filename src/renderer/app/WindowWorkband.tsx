import { Copy, Minus, PanelLeft, PanelLeftClose, Search, Square, SquarePen, X } from 'lucide-react';
import type React from 'react';
import type { WindowStateSnapshot } from '../../shared/types';
import { PreviewIcon } from '../components/PreviewIcon';

export function WindowWorkband({
  activeView,
  chatSidebarCollapsed,
  onHistorySearchToggle,
  onNewConversation,
  onSidebarToggle,
  onWindowClose,
  onWindowMaximizeToggle,
  onWindowMinimize,
  showHistorySearch,
  topMeta,
  windowState
}: {
  activeView: string;
  chatSidebarCollapsed: boolean;
  onHistorySearchToggle: () => void;
  onNewConversation: () => void;
  onSidebarToggle: () => void;
  onWindowClose: () => void;
  onWindowMaximizeToggle: () => void;
  onWindowMinimize: () => void;
  showHistorySearch: boolean;
  topMeta: string;
  windowState: WindowStateSnapshot;
}): React.JSX.Element {
  return (
    <header className="window-workband" data-testid="window-workband">
      <div className="workband-drag-region">
        <div className="workband-primary">
          <div className="brand">
            <div className="brand-mark">R</div>
          </div>
          {activeView === 'chat' ? (
            <div className="workband-chat-actions">
              <button
                aria-label={chatSidebarCollapsed ? '展开历史侧栏' : '收起历史侧栏'}
                aria-pressed={!chatSidebarCollapsed}
                className={chatSidebarCollapsed ? 'icon-button workband-chat-action is-active' : 'icon-button workband-chat-action'}
                data-testid="chat-sidebar-toggle"
                title={chatSidebarCollapsed ? '展开历史侧栏' : '收起历史侧栏'}
                type="button"
                onClick={onSidebarToggle}
              >
                {chatSidebarCollapsed ? <PanelLeft aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} /> : <PanelLeftClose aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />}
              </button>
              <button
                aria-label="搜索历史对话"
                aria-pressed={showHistorySearch}
                className={showHistorySearch ? 'icon-button workband-chat-action is-active' : 'icon-button workband-chat-action'}
                data-testid="chat-history-search-toggle"
                title="搜索历史对话"
                type="button"
                onClick={onHistorySearchToggle}
              >
                <Search aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />
              </button>
              <button
                aria-label="新建对话"
                className="icon-button workband-chat-action"
                data-testid="chat-new-conversation"
                title="新建对话"
                type="button"
                onClick={onNewConversation}
              >
                <SquarePen aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="thread-meta">
        <PreviewIcon name="folder" />
        <span>{topMeta}</span>
      </div>
      <div className="workband-actions">
        <button
          className="icon-button titlebar-button"
          data-testid="window-minimize"
          title="最小化"
          type="button"
          onClick={onWindowMinimize}
        >
          <Minus aria-hidden="true" className="titlebar-icon" size={12} strokeWidth={1.6} />
        </button>
        <button
          className="icon-button titlebar-button"
          data-testid="window-toggle-maximize"
          title={windowState.maximized ? '还原' : '最大化'}
          type="button"
          onClick={onWindowMaximizeToggle}
        >
          {windowState.maximized ? (
            <Copy aria-hidden="true" className="titlebar-icon titlebar-icon--restore" size={12} strokeWidth={1.6} />
          ) : (
            <Square aria-hidden="true" className="titlebar-icon" size={11} strokeWidth={1.7} />
          )}
        </button>
        <button
          className="icon-button titlebar-button danger"
          data-testid="window-close"
          title="关闭"
          type="button"
          onClick={onWindowClose}
        >
          <X aria-hidden="true" className="titlebar-icon" size={13} strokeWidth={1.7} />
        </button>
      </div>
    </header>
  );
}
