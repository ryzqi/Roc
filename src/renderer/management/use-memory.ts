import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MemoryKind,
  MemoryScope,
  MemoryStatus,
  SessionMessageSearchRequest,
  SessionMessageSearchResult
} from '../../shared/types';
import type { AsyncStatus } from '../app/use-async-resource';
import { useAsyncResource } from '../app/use-async-resource';
import type { RocClient } from '../shared/roc-client';
import {
  MEMORY_SLOTS,
  codePointCount,
  describeWriteOutcome,
  memorySlotKey,
  type MemorySlot,
  type WriteOutcomeDescription
} from './memory-model';
import {
  getMemorySnapshotPreview,
  getMemoryStatus,
  readMemoryFile,
  searchSessionMessages,
  writeMemoryFile,
  type MemorySnapshotPreviewText
} from './management-store';

/**
 * Memory data (P9/T9.1).
 *
 * ## Drafts are per slot, not one buffer
 *
 * The panel lists five files; a single shared draft would silently drop the edits of the file
 * the user just left. So the hook keeps `contents` (what the backend returned) and `drafts`
 * (only the slots the user actually changed) separately, and `dirty(slot)` is the comparison
 * between them. Saving writes the draft, then records the written text as the new content —
 * the backend stores the string verbatim (F24 ③), so no re-read is needed to stay truthful.
 *
 * ## The preview is its own read
 *
 * `memory.snapshot.preview` is a separate capability, not a field of `status`: it is the text
 * that would be injected into the next run, and the point of showing it is that it may
 * legitimately differ from the editor (empty slots and ineffective slots are skipped). It gets
 * its own resource with its own reload, refreshed after every successful write.
 */

export type MemoryFilesStore = {
  status: AsyncStatus;
  error: string | null;
  memory: MemoryStatus | null;
  reload: () => void;
  /** Metadata row per slot, in the backend's slot order. */
  rows: Array<{ slot: MemorySlot; meta: MemoryStatus['files'][number] | null }>;
  selectSlot: (scope: MemoryScope, kind: MemoryKind) => void;
  selected: MemorySlot;
  content: string | null;
  contentLoading: boolean;
  contentError: string | null;
  draft: string;
  setDraft: (next: string) => void;
  dirty: (slot: MemorySlot) => boolean;
  dirtyCount: number;
  save: { pending: boolean; outcome: WriteOutcomeDescription | null; error: string | null; run: () => Promise<boolean> };
  discard: () => void;
  discardAll: () => void;
};

export function useMemoryFiles(client: RocClient): MemoryFilesStore {
  const resource = useAsyncResource('memory:status', () => getMemoryStatus(client), { label: '读取记忆状态' });
  const memory = resource.data;

  const [selectedKey, setSelectedKey] = useState<string>(() => memorySlotKey(MEMORY_SLOTS[0]?.scope ?? 'global', MEMORY_SLOTS[0]?.kind ?? 'user'));
  const [contents, setContents] = useState<Record<string, string | null>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcomeDescription | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selected = useMemo(() => {
    const slot = MEMORY_SLOTS.find((candidate) => memorySlotKey(candidate.scope, candidate.kind) === selectedKey);
    return slot ?? (MEMORY_SLOTS[0] as MemorySlot);
  }, [selectedKey]);

  const loadedRef = useRef<Record<string, boolean>>({});

  const loadSlot = useCallback(
    async (slot: MemorySlot): Promise<void> => {
      const key = memorySlotKey(slot.scope, slot.kind);
      loadedRef.current[key] = true;
      setContentLoading(true);
      setContentError(null);
      try {
        const result = await readMemoryFile(client, { scope: slot.scope, kind: slot.kind });
        setContents((current) => ({ ...current, [key]: result.ok ? result.data : null }));
        if (!result.ok) {
          setContentError(result.error.message);
        }
      } catch (caught) {
        setContentError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setContentLoading(false);
      }
    },
    [client]
  );

  // Load the selected slot once (and again whenever the selection changes to an unloaded one).
  useEffect(() => {
    const key = memorySlotKey(selected.scope, selected.kind);
    if (loadedRef.current[key] === true) {
      return;
    }
    void loadSlot(selected);
  }, [loadSlot, selected]);

  // A failed status read must not leave a stale editor under it.
  const statusError = resource.error;
  useEffect(() => {
    if (statusError !== null) {
      setContentError(null);
    }
  }, [statusError]);

  const key = memorySlotKey(selected.scope, selected.kind);
  const content = contents[key] ?? null;
  const draft = drafts[key] ?? content ?? '';
  const dirty = (slot: MemorySlot): boolean => {
    const slotKey = memorySlotKey(slot.scope, slot.kind);
    const current = drafts[slotKey];
    if (current === undefined) {
      return false;
    }
    return current !== (contents[slotKey] ?? '');
  };
  const dirtyCount = MEMORY_SLOTS.filter((slot) => dirty(slot)).length;

  const setDraft = useCallback(
    (next: string) => {
      setDrafts((current) => ({ ...current, [key]: next }));
      setOutcome(null);
      setSaveError(null);
    },
    [key]
  );

  const discard = useCallback(() => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setOutcome(null);
    setSaveError(null);
  }, [key]);

  const discardAll = useCallback(() => {
    setDrafts({});
    setOutcome(null);
    setSaveError(null);
  }, []);

  const reloadStatus = resource.reload;

  const run = useCallback(async (): Promise<boolean> => {
    const slot = selected;
    const slotKey = memorySlotKey(slot.scope, slot.kind);
    const text = drafts[slotKey] ?? contents[slotKey] ?? '';
    setPending(true);
    setOutcome(null);
    setSaveError(null);
    try {
      const result = await writeMemoryFile(client, { scope: slot.scope, kind: slot.kind, content: text });
      if (!result.ok) {
        setSaveError(result.error.message);
        return false;
      }
      const description = describeWriteOutcome(result.data);
      setOutcome(description);
      if (description.status === 'saved') {
        setContents((current) => ({ ...current, [slotKey]: text }));
        setDrafts((current) => {
          const next = { ...current };
          delete next[slotKey];
          return next;
        });
        reloadStatus();
      }
      return description.status === 'saved';
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setPending(false);
    }
  }, [client, contents, drafts, reloadStatus, selected]);

  return useMemo(
    () => ({
      status: resource.status,
      error: resource.error,
      memory,
      reload: reloadStatus,
      rows: MEMORY_SLOTS.map((slot) => ({
        slot,
        meta: memory === null ? null : memory.files.find((file) => file.scope === slot.scope && file.kind === slot.kind) ?? null
      })),
      selectSlot: (scope, kind) => setSelectedKey(memorySlotKey(scope, kind)),
      selected,
      content,
      contentLoading,
      contentError,
      draft,
      setDraft,
      dirty,
      dirtyCount,
      save: { pending, outcome, error: saveError, run },
      discard,
      discardAll
    }),
    [resource.status, resource.error, memory, reloadStatus, selected, content, contentLoading, contentError, draft, setDraft, dirty, dirtyCount, pending, outcome, saveError, run, discard, discardAll]
  );
}

/* ------------------------------------------------------------------ */
/* Snapshot preview                                                    */
/* ------------------------------------------------------------------ */

export type MemoryPreviewStore = {
  status: AsyncStatus;
  error: string | null;
  text: string | null;
  charCount: number;
  reload: () => void;
};

export function useMemorySnapshot(client: RocClient, revision: number): MemoryPreviewStore {
  // The revision is part of the key: a successful write must move the preview, and the
  // capability has no push channel.
  const resource = useAsyncResource(
    `memory:preview:${revision}`,
    () => getMemorySnapshotPreview(client),
    { label: '读取记忆快照预览' }
  );
  const data: MemorySnapshotPreviewText | null = resource.data;
  return useMemo(
    () => ({
      status: resource.status,
      error: resource.error,
      text: data?.text ?? null,
      charCount: data === null ? 0 : codePointCount(data.text),
      reload: resource.reload
    }),
    [resource.status, resource.error, resource.reload, data]
  );
}

/* ------------------------------------------------------------------ */
/* Session search                                                      */
/* ------------------------------------------------------------------ */

export type SessionSearchStore = {
  query: string;
  setQuery: (next: string) => void;
  workspaceScope: 'current' | 'all';
  setWorkspaceScope: (next: 'current' | 'all') => void;
  status: AsyncStatus;
  error: string | null;
  result: SessionMessageSearchResult | null;
  run: () => void;
  reset: () => void;
};

/**
 * `agent.sessions.search` — the only search the memory domain exposes (F24 ①).
 *
 * `workspaceHash` comes from `memory.status` rather than being computed here: the hash is the
 * backend's own derivation of the bound working directory, and a second implementation would be
 * a second answer to "which conversations are current".
 */
export function useSessionSearch(
  client: RocClient,
  workspaceHash: string | null,
  limit = 20
): SessionSearchStore {
  const [query, setQuery] = useState('');
  const [workspaceScope, setWorkspaceScope] = useState<'current' | 'all'>('all');
  const [status, setStatus] = useState<AsyncStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionMessageSearchResult | null>(null);

  const run = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setStatus('idle');
      setResult(null);
      return;
    }
    setStatus('loading');
    setError(null);
    // `workspaceHash` is only meaningful with `workspaceScope: 'current'`; sending it with `'all'`
    // would be an argument the backend has no use for. The explicit object keeps that visible
    // instead of hiding it behind a conditional spread.
    const request: SessionMessageSearchRequest = { query: trimmed, workspaceScope, limit };
    if (workspaceScope === 'current' && workspaceHash !== null) {
      request.workspaceHash = workspaceHash;
    }
    void searchSessionMessages(client, request)
      .then((outcome) => {
        if (!outcome.ok) {
          setStatus('error');
          setError(outcome.error.message);
          setResult(null);
          return;
        }
        setStatus('ready');
        setResult(outcome.data);
      })
      .catch((caught: unknown) => {
        setStatus('error');
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, [client, limit, query, workspaceHash, workspaceScope]);

  const reset = useCallback(() => {
    setQuery('');
    setStatus('idle');
    setResult(null);
    setError(null);
  }, []);

  return { query, setQuery, workspaceScope, setWorkspaceScope, status, error, result, run, reset };
}
