import { useCallback, useEffect, useRef, useState } from 'react';
import type { RocClient } from '../shared/roc-client';
import { appRouteToSearch, normalizeAppRoute, readAppRoute, routeForNavigate, sameAppRoute, writeAppRoute, type AppRoute } from './routes';

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
 * Routes native-menu payloads into the URL.
 *
 * `application-menu.ts` (⌘N, ⌘,) and `macos-host-service.ts` broadcast literal
 * page names — `settings`, `research-new`, `chat`, `tasks` — not view ids, so
 * the mapping lives in `routeForNavigate` rather than being guessed here.
 */
export function useAppNavigateBridge(client: RocClient, controller: AppRouteController): void {
  const { navigate } = controller;
  const routeRef = useRef(controller.route);
  routeRef.current = controller.route;

  useEffect(
    () =>
      client.api.app.onNavigate((page) => {
        navigate(routeForNavigate(page, routeRef.current));
      }),
    [client, navigate]
  );
}
