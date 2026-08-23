import { Search } from 'lucide-react';
import { memo, type Dispatch, type RefObject, type SetStateAction } from 'react';

import type { HistorySidebarItem } from '../history-sidebar';
import { PreviewIcon } from '../components/PreviewIcon';
import { HistoryThreadRow } from './sidebar/HistoryThreadMenu';
import { NavButton } from './sidebar/NavButton';
import { SidebarBlock } from './sidebar/SidebarBlock';
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
  onSelectNavItem: (item: NavItem) => void;
  selectHistoryThread: (threadId: string) => void;
  selectWorkspaceFromDialog: () => Promise<void>;
  selectedThreadId: string | null;
  setHistorySearchQuery: Dispatch<SetStateAction<string>>;
  showHistorySearch: boolean;
  showHistorySearchEmpty: boolean;
  state: NonNullable<AppBootstrap['state']>;
  visibleHistoryItems: HistorySidebarItem[];
  workspaceNavItems: NavItem[];
  workspaceSelectError: string | null;
}

export const AppSidebar = memo(function AppSidebar({
  activeView,
  controlNavItems,
  deleteHistoryThread,
  historyItems,
  historyNavItems,
  historySearchInputRef,
  historySearchQuery,
  onOpenSettings,
  onSelectNavItem,
  selectHistoryThread,
  selectWorkspaceFromDialog,
  selectedThreadId,
  setHistorySearchQuery,
  showHistorySearch,
  showHistorySearchEmpty,
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
      {historyNavItems.map((item) => (
        <NavButton active={item.active ?? item.id === activeView} item={item} key={item.id} onSelect={onSelectNavItem} />
      ))}
      <SidebarBlock
        className={showHistorySearch ? 'sidebar-block sidebar-block--history sidebar-block--history-search' : 'sidebar-block sidebar-block--history'}
        head={
          showHistorySearch ? (
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
          ) : undefined
        }
        scrollClassName="history-list"
        title="历史会话"
      >
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
      </SidebarBlock>
      {/* 底部 dock：常驻固定行，永不参与弹性收缩，最小窗口高度下也完整可见。 */}
      <nav aria-label="工作台与控制" className="sidebar-dock">
        <div className="sidebar-dock-group">
          {workspaceNavItems.map((item) => (
            <NavButton active={item.active ?? item.id === activeView} item={item} key={item.id} onSelect={onSelectNavItem} />
          ))}
        </div>
        <div className="sidebar-dock-group">
          {controlNavItems.map((item) => (
            <NavButton active={item.active ?? item.id === activeView} item={item} key={item.id} onSelect={onSelectNavItem} />
          ))}
        </div>
        <div className="sidebar-dock-group">
          <button
            className="nav-button nav-button--dock"
            data-testid="settings-gear"
            type="button"
            onClick={(event) => onOpenSettings(event.currentTarget)}
            title="打开设置"
          >
            <PreviewIcon name="wrench" />
            <span className="nav-label">设置</span>
          </button>
        </div>
      </nav>
    </aside>
  );
});
