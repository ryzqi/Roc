import { Search } from 'lucide-react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { HistorySidebarItem } from '../history-sidebar';
import { PreviewIcon } from '../components/PreviewIcon';
import { HistoryThreadRow } from './sidebar/HistoryThreadMenu';
import { SidebarNavGroup } from './sidebar/SidebarNavGroup';
import type { NavItem, ViewId } from './types';
import { visibleWorkspaceLabel } from './view-routing';
import type { AppBootstrap } from './use-app-bootstrap';

interface AppSidebarProps {
  activeView: ViewId;
  controlNavItems: NavItem[];
  deleteHistoryThread: (threadId: string) => Promise<void>;
  historyItems: HistorySidebarItem[];
  historyNavItems: NavItem[];
  historySearchInputRef: RefObject<HTMLInputElement | null>;
  historySearchQuery: string;
  onOpenSettings: (opener: HTMLElement) => void;
  selectHistoryThread: (threadId: string) => void;
  selectWorkspaceFromDialog: () => Promise<void>;
  selectedThreadId: string | null;
  setActiveView: Dispatch<SetStateAction<ViewId>>;
  setHistorySearchQuery: Dispatch<SetStateAction<string>>;
  showHistorySearch: boolean;
  showHistorySearchEmpty: boolean;
  startNewConversation: () => void;
  state: NonNullable<AppBootstrap['state']>;
  visibleHistoryItems: HistorySidebarItem[];
  workspaceNavItems: NavItem[];
  workspaceSelectError: string | null;
}

export function AppSidebar({
  activeView,
  controlNavItems,
  deleteHistoryThread,
  historyItems,
  historyNavItems,
  historySearchInputRef,
  historySearchQuery,
  onOpenSettings,
  selectHistoryThread,
  selectWorkspaceFromDialog,
  selectedThreadId,
  setActiveView,
  setHistorySearchQuery,
  showHistorySearch,
  showHistorySearchEmpty,
  startNewConversation,
  state,
  visibleHistoryItems,
  workspaceNavItems,
  workspaceSelectError
}: AppSidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button
          className="workspace-pill"
          data-testid="workspace-select-button"
          title={visibleWorkspaceLabel(state)}
          type="button"
          onClick={() => void selectWorkspaceFromDialog()}
        >
          <PreviewIcon name="folder" />
          <span>{visibleWorkspaceLabel(state)}</span>
          <strong>选择</strong>
        </button>
        {workspaceSelectError === null ? null : <span className="inline-warning">{workspaceSelectError}</span>}
      </div>
      {historyNavItems.length === 0 ? null : (
        <SidebarNavGroup
          activeView={activeView}
          items={historyNavItems}
          title="对话"
          onSelect={(item) => {
            if (item.id === 'chat') {
              startNewConversation();
              return;
            }
            setActiveView(item.id);
          }}
        />
      )}
      <div className="sidebar-block sidebar-block--history">
        <div className="side-title">历史会话</div>
        {showHistorySearch ? (
          <label className="history-search-field">
            <Search aria-hidden="true" className="icon-svg" size={15} strokeWidth={1.8} />
            <input
              aria-label="搜索历史会话"
              data-testid="chat-history-search-input"
              placeholder="搜索历史会话"
              ref={historySearchInputRef}
              type="search"
              value={historySearchQuery}
              onChange={(event) => {
                setHistorySearchQuery(event.target.value);
              }}
            />
          </label>
        ) : null}
        <div className="sidebar-block-scroll history-list">
          {historyItems.length === 0 ? (
            <div className="history-empty">暂无历史会话</div>
          ) : showHistorySearchEmpty ? (
            <div className="history-empty" data-testid="chat-history-search-empty">未找到匹配的历史会话</div>
          ) : (
            visibleHistoryItems.map((item) => (
              <HistoryThreadRow
                item={item}
                key={item.id}
                selected={item.id === selectedThreadId}
                onDelete={deleteHistoryThread}
                onSelect={selectHistoryThread}
              />
            ))
          )}
        </div>
      </div>
      <SidebarNavGroup
        className="sidebar-block sidebar-block--tasks"
        activeView={activeView}
        items={workspaceNavItems}
        title="任务工作台"
        onSelect={(item) => setActiveView(item.id)}
      />
      <SidebarNavGroup
        className="sidebar-block sidebar-block--control"
        activeView={activeView}
        items={controlNavItems}
        title="控制区"
        onSelect={(item) => setActiveView(item.id)}
      />
      <div className="sidebar-footer">
        <button
          className="settings-gear"
          data-testid="settings-gear"
          type="button"
          onClick={(event) => onOpenSettings(event.currentTarget)}
          title="打开设置"
          aria-label="打开设置"
        >
          <PreviewIcon name="wrench" />
        </button>
      </div>
    </aside>
  );
}
