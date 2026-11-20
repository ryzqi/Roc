import { useCallback, useEffect, useState } from 'react';
import type { TraySummary } from '../../shared/types';
import { errorMessage } from '../app/loaded-state';
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

export type TraySummaryResource = {label: string | null; error: string | null; reload: () => void};

export function useTraySummaryLabel(client: RocClient, windowHidden: boolean): TraySummaryResource {
  const [snapshot, setSnapshot] = useState<{client: RocClient; summary: TraySummary | null; error: string | null}>({
    client, summary: null, error: null
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce(current => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    let revision = 0;

    const refresh = async (): Promise<void> => {
      const request = ++revision;
      try {
        const result = await client.api.lifecycle.getTraySummary();
        if (cancelled || request !== revision) return;
        if (result.ok) setSnapshot({client, summary: result.data, error: null});
        else setSnapshot(current => ({
          client, summary: current.client === client ? current.summary : null, error: result.error.message
        }));
      } catch (error) {
        if (!cancelled && request === revision) {
          setSnapshot(current => ({
            client, summary: current.client === client ? current.summary : null, error: errorMessage(error)
          }));
        }
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
  }, [client, windowHidden, nonce]);

  return {
    label: traySummaryLabel(snapshot.client === client ? snapshot.summary : null),
    error: snapshot.client === client ? snapshot.error : null,
    reload
  };
}
