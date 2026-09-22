import { Plus, Settings, SquarePen } from 'lucide-react';
import type React from 'react';
import { PreviewIcon } from '../components/PreviewIcon';
import type { ResearchServiceContext } from '../views/research/research-services';

export function WindowWorkband({
  activeView,
  onNewConversation,
  onNewProject,
  onOpenSettings,
  onReturnToProjects,
  researchContext,
  topMeta
}: {
  activeView: string;
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
          <div className="brand">
            <div className="brand-mark">R</div>
          </div>
          {inProject ? (
            <div className="workband-chat-actions">
              <button
                aria-keyshortcuts="Meta+[ Control+["
                aria-label="所有项目"
                className="workband-chat-action"
                data-testid="research-shell-all-projects"
                title="返回所有项目（⌘[）"
                type="button"
                onClick={onReturnToProjects}
              >
                所有项目
              </button>
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
          ) : activeView === 'research' ? (
            <div className="workband-chat-actions">
              <button
                aria-label="新建研究项目"
                className="icon-button workband-chat-action"
                data-testid="research-top-new-project"
                title="新建研究项目"
                type="button"
                onClick={onNewProject}
              >
                <Plus aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="thread-meta">
        <PreviewIcon name="microscope" />
        <span>{inProject ? researchContext.projectTitle : topMeta}</span>
      </div>
      <div className="workband-chat-actions">
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
