import type { AppRoute } from './routes';

export type UxEvent = 'screen_open' | 'action_initiated' | 'task_state_changed' | 'back_navigation' | 'error_recovered' | 'onboarding_dismissed';
type Metric = { event: UxEvent; surface: string; elapsedMs: number };
const events: Metric[] = [];
const startedAt = performance.now();

/** Session-only diagnostics. Never record project ids, text, paths or credentials. */
export function recordUxEvent(event: UxEvent, surface: AppRoute['view'] | AppRoute['page'] | 'portal' | 'assistant' | 'tasks'): void {
  events.push({ event, surface, elapsedMs: Math.round(performance.now() - startedAt) });
  if (events.length > 500) events.shift();
}

export function recordScreenOpen(route: AppRoute): void {
  recordUxEvent('screen_open', route.page === 'settings' ? 'settings' : route.projectId === null ? 'portal' : route.view);
}

export function exportUxMetrics(): string {
  return JSON.stringify({ version: 1, events }, null, 2);
}
