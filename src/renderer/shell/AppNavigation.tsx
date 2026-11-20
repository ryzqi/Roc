import { BookOpen, Compass, FileText, House, LibraryBig } from 'lucide-react';
import { canvasTabIds, surfaceFor, type CanvasTabId } from '../../shared/surfaces';

const icons = { overview: House, discover: Compass, library: BookOpen, knowledge: LibraryBig, writing: FileText };

export function AppNavigation({ view, onNavigate }: { view: CanvasTabId; onNavigate: (view: CanvasTabId) => void }): React.JSX.Element {
  return <nav aria-label="项目导航" className="shrink-0 space-y-1 border-b-[0.5px] border-line p-2">
    {canvasTabIds.map(id => {
      const Icon = icons[id];
      return <button key={id} type="button" aria-current={view === id ? 'page' : undefined}
        data-testid={`sidebar-nav-${id}`} onClick={() => onNavigate(id)}
        className="flex min-h-8 w-full items-center gap-2 rounded-control px-3 text-text hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] aria-[current=page]:bg-[var(--overlay-active)] aria-[current=page]:font-medium aria-[current=page]:text-ink focus-visible:outline-2 focus-visible:outline-accent">
        <Icon size={16} aria-hidden="true" /><span>{surfaceFor(id).label}</span>
      </button>;
    })}
  </nav>;
}
