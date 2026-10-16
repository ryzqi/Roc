import { useEffect, useState } from 'react';
import type { TraySummary } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';

/**
 * Background-run hint for the window chrome.
 *
 * `lifecycle.getTraySummary` has no push channel — `tasks.onUpdated` is the only
 * task event and it does not carry the tray projection — so this is an explicit
 * poll. It pauses while the window is hidden: a background window has nobody to
 * show the hint to, and the point of the summary is that background work keeps
 * running while the window is *away* (the main process owns the tray).
 */

const POLL_INTERVAL_MS = 30_000;

/** e.g. "后台 2 项运行中" / "后台待确认 1 项" / null when there is nothing to say. */
export function traySummaryLabel(summary: TraySummary | null): string | null {
  if (summary === null) {
    return null;
  }
  const { running, pendingConfirmation, failed } = summary.backgroundTasks;
  if (pendingConfirmation > 0) {
    return `后台待确认 ${pendingConfirmation} 项`;
  }
  if (failed > 0 && running === 0) {
    return `后台失败 ${failed} 项`;
  }
  if (running > 0) {
    return `后台 ${running} 项运行中`;
  }
  return null;
}

export function useTraySummaryLabel(client: RocClient, windowHidden: boolean): string | null {
  const [summary, setSummary] = useState<TraySummary | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async (): Promise<void> => {
      const result = await client.api.lifecycle.getTraySummary();
      if (!cancelled && result.ok) {
        setSummary(result.data);
      }
    };

    void refresh();
    if (windowHidden) {
      return () => {
        cancelled = true;
      };
    }

    const handle = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [client, windowHidden]);

  return traySummaryLabel(summary);
}
