import { BookOpen, FileText, House, ListChecks } from 'lucide-react';
import type { AppViewId } from '../app/routes';
import './chrome.css';

export const workspaceModes = [
  { id: 'overview', label: '总览与发现', icon: House },
  { id: 'library', label: '文献与知识', icon: BookOpen },
  { id: 'writing', label: '论文写作', icon: FileText },
  { id: 'runs', label: '会话与任务', icon: ListChecks }
] as const;

export type WorkspaceMode = (typeof workspaceModes)[number]['id'];

export function AppNavigation({ view, onNavigate }: {
  view: AppViewId;
  onNavigate: (view: WorkspaceMode) => void;
}): React.JSX.Element {
  return (
    <nav aria-label="项目导航" className="grid gap-1">
      {workspaceModes.map(({ id, label, icon: Icon }, index) => (
        <button key={id} type="button" className="chrome-control activity-destination relative size-9"
          aria-current={view === id ? 'page' : undefined} aria-label={label}
          aria-keyshortcuts={`Meta+Alt+${index + 1}`} title={`${label}（⌘⌥${index + 1}）`}
          data-testid={`activity-nav-${id}`} onClick={() => onNavigate(id)}>
          <Icon size={18} aria-hidden="true" />
        </button>
      ))}
    </nav>
  );
}
