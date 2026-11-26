import { useCallback, useSyncExternalStore } from 'react';
import type { RendererImageAttachment } from './image-attachments.ts';

export type AssistantComposerDraft = {
  text: string;
  attachments: RendererImageAttachment[];
};

export type AssistantComposerDraftUpdater = (
  current: AssistantComposerDraft
) => AssistantComposerDraft;

const EMPTY_DRAFT: AssistantComposerDraft = { text: '', attachments: [] };
// Drafts can contain private input, so keep them in memory. Reject growth visibly
// rather than evicting unsent text or attachments to make room for another draft.
export const assistantComposerDraftLimits = { bytes: 128 * 1024 * 1024, count: 128 } as const;
const drafts = new Map<string, { draft: AssistantComposerDraft; bytes: number }>();
const listeners = new Map<string, Set<() => void>>();
let retainedBytes = 0;

function draftBytes(draft: AssistantComposerDraft): number {
  // Count both payload and preview conservatively as UTF-16, even when V8 shares
  // their backing strings. Include fixed overhead for the draft and attachments.
  let bytes = 256 + draft.text.length * 2;
  for (const attachment of draft.attachments) {
    bytes += 256 + 2 * (attachment.name.length + (attachment.data?.length ?? 0) +
      (attachment.path?.length ?? 0) + (attachment.previewUrl?.length ?? 0));
  }
  return bytes;
}

function deleteDraft(key: string): boolean {
  const entry = drafts.get(key);
  if (entry === undefined) return false;
  retainedBytes -= entry.bytes;
  drafts.delete(key);
  return true;
}

function draftKey(projectId: string | null, threadId: string | null): string {
  return JSON.stringify([projectId, threadId]);
}

function readDraft(key: string): AssistantComposerDraft {
  return drafts.get(key)?.draft ?? EMPTY_DRAFT;
}

function notify(key: string): void {
  listeners.get(key)?.forEach((listener) => listener());
}

function subscribe(key: string, listener: () => void): () => void {
  const subscribers = listeners.get(key) ?? new Set<() => void>();
  subscribers.add(listener);
  listeners.set(key, subscribers);

  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      listeners.delete(key);
    }
  };
}

export function updateAssistantComposerDraft(
  projectId: string | null,
  threadId: string | null,
  update: AssistantComposerDraftUpdater
): void {
  const key = draftKey(projectId, threadId);
  const next = update(readDraft(key));
  if (next.text.length === 0 && next.attachments.length === 0) {
    deleteDraft(key);
  } else {
    const previousBytes = drafts.get(key)?.bytes ?? 0;
    const bytes = draftBytes(next);
    if ((previousBytes === 0 && drafts.size >= assistantComposerDraftLimits.count) ||
        (bytes > previousBytes && retainedBytes - previousBytes + bytes > assistantComposerDraftLimits.bytes)) {
      throw new Error('assistant_composer_draft_capacity');
    }
    retainedBytes += bytes - previousBytes;
    drafts.set(key, { draft: next, bytes });
  }
  notify(key);
}

export function migrateAssistantComposerDraft(
  projectId: string | null,
  fromThreadId: string | null,
  toThreadId: string
): void {
  const fromKey = draftKey(projectId, fromThreadId);
  const toKey = draftKey(projectId, toThreadId);
  const draft = drafts.get(fromKey);
  if (draft === undefined || drafts.has(toKey)) {
    return;
  }
  drafts.delete(fromKey);
  drafts.set(toKey, draft);
  notify(fromKey);
  notify(toKey);
}

export function clearAssistantComposerDraft(
  projectId: string | null,
  threadId: string | null,
  expectedDraft?: AssistantComposerDraft
): void {
  const key = draftKey(projectId, threadId);
  if (expectedDraft !== undefined && readDraft(key) !== expectedDraft) return;
  if (deleteDraft(key)) {
    notify(key);
  }
}

export function clearProjectAssistantComposerDrafts(projectId: string): void {
  for (const key of drafts.keys()) {
    const [draftProjectId] = JSON.parse(key) as [string | null, string | null];
    if (draftProjectId === projectId && deleteDraft(key)) notify(key);
  }
}

/** Threads are global; a deleted thread can have drafts in several project scopes. */
export function clearThreadAssistantComposerDrafts(threadId: string): void {
  for (const key of drafts.keys()) {
    const [, draftThreadId] = JSON.parse(key) as [string | null, string | null];
    if (draftThreadId === threadId && deleteDraft(key)) notify(key);
  }
}

export function useAssistantComposerDraft(
  projectId: string | null,
  threadId: string | null
): {
  draft: AssistantComposerDraft;
  updateDraft: (update: AssistantComposerDraftUpdater) => void;
} {
  const key = draftKey(projectId, threadId);
  const subscribeToDraft = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  const getSnapshot = useCallback(() => readDraft(key), [key]);
  const draft = useSyncExternalStore(subscribeToDraft, getSnapshot, getSnapshot);
  const updateDraft = useCallback(
    (update: AssistantComposerDraftUpdater) => updateAssistantComposerDraft(projectId, threadId, update),
    [projectId, threadId]
  );

  return { draft, updateDraft };
}
