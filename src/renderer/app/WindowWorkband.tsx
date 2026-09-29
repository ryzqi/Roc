import { ChevronLeft, Plus, Settings, SquarePen } from 'lucide-react';
import type React from 'react';
import type { ResearchServiceContext } from '../views/research/research-services';

export function WindowWorkband({
  activeView,
  canGoBack,
  onNewConversation,
  onNewProject,
  onOpenSettings,
  onReturnToProjects,
  researchContext,
  topMeta
}: {
  activeView: string;
  canGoBack: boolean;
  onNewConversation: () => void;
  onNewProject: () => void;
  onOpenSettings: (opener: HTMLElement) => void;
  onReturnToProjects: () => void;
  researchContext: ResearchServiceContext | null;
  topMeta: string;
}): React.JSX.Element {
  const inProject = researchContext !== null && researchContext.projectTitle !== null;
  return (
    <header className="window-workband" data-testid="window-workband">
      <div className="workband-drag-region">
        <div className="workband-primary">
          {canGoBack ? (
            <button
              aria-label={inProject ? '返回所有项目' : '返回项目列表'}
              className="workband-chat-action"
              data-testid="research-shell-all-projects"
              title="返回（⌘[）"
              type="button"
              onClick={onReturnToProjects}
            >
              <ChevronLeft aria-hidden="true" className="icon-svg" size={17} strokeWidth={1.8} />
            </button>
          ) : null}
          {inProject ? (
            <div className="workband-chat-actions">
              {activeView === 'chat' ? (
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
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="thread-meta">
        <span>{inProject ? researchContext.projectTitle : topMeta}</span>
      </div>
      <div className="workband-chat-actions">
        <button
          aria-label={activeView === 'research' ? '新建研究项目' : '新建'}
          className="icon-button workband-chat-action"
          data-testid="research-top-new-project"
          title={activeView === 'research' ? '新建研究项目' : '新建'}
          type="button"
          onClick={activeView === 'research' ? onNewProject : onNewConversation}
        >
          {activeView === 'research' ? (
            <Plus aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />
          ) : (
            <SquarePen aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />
          )}
        </button>
        <button
          aria-label="打开设置"
          className="icon-button workband-chat-action"
          data-testid="settings-gear"
          title="打开设置"
          type="button"
          onClick={(event) => onOpenSettings(event.currentTarget)}
        >
          <Settings aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}
