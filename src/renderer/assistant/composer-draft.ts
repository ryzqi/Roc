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
const drafts = new Map<string, AssistantComposerDraft>();
const listeners = new Map<string, Set<() => void>>();

function draftKey(projectId: string | null, threadId: string | null): string {
  return JSON.stringify([projectId, threadId]);
}

function readDraft(key: string): AssistantComposerDraft {
  return drafts.get(key) ?? EMPTY_DRAFT;
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
    drafts.delete(key);
  } else {
    drafts.set(key, next);
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
  threadId: string | null
): void {
  const key = draftKey(projectId, threadId);
  if (drafts.delete(key)) {
    notify(key);
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
