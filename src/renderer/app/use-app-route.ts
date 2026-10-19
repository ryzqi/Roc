import { useCallback, useEffect, useRef, useState } from 'react';
import type { RocClient } from '../shared/roc-client';
import { menuIntentForPage, type MenuIntent } from '../../shared/surfaces';
import { appRouteToSearch, normalizeAppRoute, readAppRoute, sameAppRoute, writeAppRoute, type AppRoute } from './routes';

/**
 * URL-backed navigation state (ADR-M05).
 *
 * The URL is the single source of truth: this hook mirrors it into React state,
 * mirrors user actions back into it, and follows the native menu through
 * `app.onNavigate`. No component keeps a second copy of "where am I".
 *
 * All writes go through `replaceState` by default, matching the legacy shell —
 * switching canvas views should not fill the history stack. `push` is available
 * for the few transitions a user would expect Back to undo (entering a project).
 */

export type NavigateOptions = { mode?: 'replace' | 'push' };

export type AppRouteController = {
  route: AppRoute;
  navigate: (next: AppRoute, options?: NavigateOptions) => void;
};

export function useAppRoute(): AppRouteController {
  const [route, setRoute] = useState<AppRoute>(() => readAppRoute());
  // Mirror used to compare against the latest route without re-creating the
  // callback (which would churn every effect that depends on `navigate`).
  const routeRef = useRef(route);
  routeRef.current = route;

  // Canonicalise once on boot so the address bar cannot claim a state the
  // parser would not produce (e.g. `?view=files` with no project).
  useEffect(() => {
    const initial = readAppRoute();
    if (appRouteToSearch(initial) !== window.location.search.replace(/^\?/u, '')) {
      writeAppRoute(initial);
    }
  }, []);

  useEffect(() => {
    const onPopState = (): void => {
      const next = readAppRoute();
      routeRef.current = next;
      setRoute(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: AppRoute, options?: NavigateOptions) => {
    const normalized = normalizeAppRoute(next);
    if (sameAppRoute(routeRef.current, normalized)) {
      return;
    }
    writeAppRoute(normalized, options?.mode ?? 'replace');
    routeRef.current = normalized;
    setRoute(normalized);
  }, []);

  return { route, navigate };
}

/**
 * Routes native-menu payloads to the shell as intents.
 *
 * `application-menu.ts` (⌘N, ⌘,) and `macos-host-service.ts` (托盘、全局热键) broadcast page names,
 * and `src/shared/surfaces.ts` owns the closed set of them plus what each one means.
 *
 * ## Why an intent and not a route
 *
 * The previous bridge built a whole `AppRoute` from the page. That works for three of the four
 * pages and **cannot** work for the fourth: 托盘「打开任务」 means "开管理抽屉的任务分区", and the
 * drawer's open section is not a route field. The old code silently gave up on it —
 * `routeForNavigate('tasks')` returned the current route, the `sameAppRoute` early-return then
 * dropped the navigation, and the menu item did nothing but raise the window while its own comment
 * claimed the drawer was opened. A shell that receives the *intent* has somewhere to put it.
 *
 * An unregistered page is ignored. It should be unreachable: the preload method is typed over
 * `MenuPage`, so the only way to get here with an unknown string is a payload built outside the
 * contract, and inventing a navigation for it would be worse than doing nothing.
 */
export function useMenuIntentBridge(client: RocClient, onIntent: (intent: MenuIntent) => void): void {
  const handlerRef = useRef(onIntent);
  handlerRef.current = onIntent;

  useEffect(
    () =>
      client.api.app.onNavigate((page) => {
        const intent = menuIntentForPage(page);
        if (intent === null) {
          return;
        }
        handlerRef.current(intent);
      }),
    [client]
  );
}
