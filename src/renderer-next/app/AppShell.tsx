import { useEffect, useState } from 'react';
import type { AppStatus } from '../../shared/types';
import { errorMessage } from './loaded-state';
import { appRouteToSearch, readAppRoute, sameAppRoute, writeAppRoute, type AppRoute } from './routes';
import { ViewContent } from './ViewContent';
import { purgeLegacyStorage } from './ui-state';
import { useAppearanceOverride, useAppearanceSync } from '../shell/appearance';
import { StartupFailure, StartupLoading } from '../shell/StartupSurface';
import type { RocClient } from '../shared/roc-client';

/**
 * P0 skeleton shell.
 *
 * Boots the app, applies the system appearance, and lays out the three columns
 * the real IA needs (sidebar / canvas / assistant). The panels are placeholders
 * — P0 is forbidden from building business UI — but the **route module and the
 * lazy view host are wired for real**, so the URL contract from ADR-M05 is
 * exercised at runtime instead of only type-checked. P1 replaces each
 * placeholder with the real component; see `.planning/phases/P1-shell.md`.
 *
 * Not yet wired (P1 owns them): `app.onNavigate` (⌘N / ⌘, / tray), the
 * resizable dividers, the shortcut table, and the drawer/overlay shells.
 */

type BootState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; appStatus: AppStatus };

export function AppShell({ client }: { client: RocClient }): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });
  const [route, setRoute] = useState<AppRoute>(() => readAppRoute());
  const { override, cycle: cycleTheme } = useAppearanceOverride();

  // Cleanup of pre-migration keys. Deliberately not a compatibility layer:
  // nothing reads these values, we just stop them from accumulating.
  useEffect(() => {
    purgeLegacyStorage();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.api.app.getStatus();
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setBoot({ status: 'failed', message: result.error.message });
          return;
        }
        setBoot({ status: 'ready', appStatus: result.data });
      } catch (error) {
        if (!cancelled) {
          setBoot({ status: 'failed', message: errorMessage(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useAppearanceSync(client, boot.status === 'ready' ? boot.appStatus.appearance : null, override);

  // URL is the source of truth for navigation (ADR-M05). The shell mirrors
  // popstate/back-forward into state and never owns a second copy of the truth.
  useEffect(() => {
    const onPopState = (): void => {
      setRoute((current) => {
        const next = readAppRoute();
        return sameAppRoute(current, next) ? current : next;
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Canonicalise the URL once on boot: a link like `?view=files` with no
  // `project` must resolve to the portal, and the address bar should say so
  // (MASTER v2 §6.5 / ADR-M05). Idempotent, so it only rewrites real drift.
  useEffect(() => {
    const initial = readAppRoute();
    const canonicalSearch = appRouteToSearch(initial);
    if (canonicalSearch !== window.location.search.replace(/^\?/u, '')) {
      writeAppRoute(initial);
    }
  }, []);

  // ⌘D cycles the in-app theme override. The rest of the shortcut table
  // (⌘B / ⌘J / ⌘K / ⌘, / ⌘N) is P1/T1.7.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        cycleTheme();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cycleTheme]);

  if (boot.status === 'loading') {
    return <StartupLoading />;
  }
  if (boot.status === 'failed') {
    return <StartupFailure message={boot.message} />;
  }

  const inProject = route.projectId !== null;
  const stageHint = route.view === 'stage' ? route.stageTab : null;

  return (
    <div className="flex h-full w-full flex-col bg-bg text-ink" data-testid="roc-app" data-mode={boot.appStatus.mode}>
      <header
        className="drag-region flex h-11 shrink-0 items-center gap-2 border-b border-line px-3"
        data-testid="shell-titlebar"
      >
        {/* 86px inset total so the system traffic lights are not covered:
            74px padding + 12px from the header's own px-3. */}
        <span className="pl-[74px] text-muted">Roc</span>
        <span className="text-subtle" data-testid="shell-workspace-label">
          {boot.appStatus.workspace.label}
        </span>
        <span className="ml-auto text-subtle" data-testid="shell-route-view">
          {route.view}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-bg-soft" data-testid="shell-sidebar">
          <p className="p-3 text-muted">左栏骨架（P1 实现）</p>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col" data-testid="shell-canvas">
          {inProject ? (
            <ViewContent view={route.view} projectId={route.projectId} stageHint={stageHint} />
          ) : (
            <div className="flex h-full w-full items-center justify-center p-6" data-testid="portal-placeholder">
              <div className="rounded-card border border-line bg-surface px-5 py-4 text-center">
                <p className="text-ink">项目门户</p>
                <p className="mt-1 text-muted">尚未实现 · P2 实现</p>
              </div>
            </div>
          )}
        </main>
        <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-bg-soft" data-testid="shell-assistant">
          <p className="p-3 text-muted">助手骨架（P4 实现）</p>
        </aside>
      </div>
    </div>
  );
}
