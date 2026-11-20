import { FileText, Moon, RotateCcw, Settings, Sun, SunMoon } from 'lucide-react';
import { THEME_LABELS } from '../app/hooks/useThemeSync';
import type { AppViewId } from '../app/routes';
import type { ThemeOverride } from '../app/ui-state';
import { AppNavigation, type WorkspaceMode } from './AppNavigation';

const themeIcons = { system: SunMoon, dark: Moon, light: Sun, paper: FileText };

export function ActivityRail({ view, onNavigate, themeOverride, onCycleTheme, onResetLayout, onOpenSettings }: {
  view: AppViewId | null;
  onNavigate: (view: WorkspaceMode) => void;
  themeOverride: ThemeOverride;
  onCycleTheme: () => void;
  onResetLayout: () => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const themeLabel = THEME_LABELS[themeOverride];
  const ThemeIcon = themeIcons[themeOverride];
  return (
    <aside aria-label="活动栏" data-testid="activity-rail"
      className="flex w-[52px] shrink-0 flex-col justify-between gap-2 border-e-[0.5px] border-line-default bg-surface-rail p-2">
      {view === null ? null : <AppNavigation view={view} onNavigate={onNavigate} />}
      <div className="mt-auto grid gap-1">
        <button type="button" onClick={onCycleTheme} className="chrome-control size-9"
          aria-label={`切换外观，当前${themeLabel}`} aria-keyshortcuts="Meta+D"
          title={`切换外观（⌘D），当前${themeLabel}`} data-testid="activity-theme">
          <ThemeIcon size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={onResetLayout} className="chrome-control size-9" disabled={view === null}
          aria-label="重置布局" title="重置布局" data-testid="activity-reset-layout">
          <RotateCcw size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={onOpenSettings} className="chrome-control size-9"
          aria-label="设置" aria-keyshortcuts="Meta+," title="设置（⌘,）" data-testid="activity-settings">
          <Settings size={16} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
