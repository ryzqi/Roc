import { useSyncExternalStore } from 'react';

/**
 * Configuration change broadcast (P8/T8.4, shared in P9).
 *
 * P8 named it for the settings centre because that was the only writer; P9 added two more writers
 * of the same *cached configuration* (`skills.setEnabled`/`import`/`delete` and the MCP server
 * mutations change the `skills`/`mcpServers` arrays inside `settings.get`'s snapshot), so it lives
 * in `shared/` and the name is about the fact rather than about one surface: **a consumer's cached
 * configuration is stale now**.
 *
 * The settings centre is the single writer for model/index configuration, and the
 * consumers of that configuration are **already mounted** elsewhere in the shell
 * (the assistant's model label, the project's embedding summary, RAG Studio's
 * effective index config). A save must reach them without a reload, and the
 * contract has no push channel for `settings.*` — so the writer tells the readers.
 *
 * A monotonically increasing revision, not an event payload: a consumer keys its
 * `useAsyncResource` on the revision, which makes "stale configuration" a key change
 * the resource loader already knows how to handle (drop the old scope, re-read,
 * ignore a response that arrives after the next change). Passing the snapshot
 * through an event bus instead would create a second copy of settings state.
 *
 * Deliberately outside `ui-state.ts`: this is in-memory process state, not a
 * persisted preference, and nothing here touches `localStorage`.
 */

type Listener = () => void;

let revision = 0;
const listeners = new Set<Listener>();

export function settingsRevision(): number {
  return revision;
}

export function notifySettingsChanged(): void {
  revision += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current settings revision; changes on every successful settings write. */
export function useSettingsRevision(): number {
  return useSyncExternalStore(subscribeSettings, settingsRevision, settingsRevision);
}
