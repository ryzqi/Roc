import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';

type EditorDraft = {
  label: string;
  dirty: boolean;
  busy: boolean;
  discard: () => void;
  /** A synchronous write lock also protects transitions before React commits pending. */
  pendingRef?: React.RefObject<boolean>;
};

type EditorGuard = {
  register: (read: () => EditorDraft) => () => void;
  notify: () => void;
  busy: () => boolean;
  request: (transition: () => void) => void;
};

export const SettingsEditorGuardContext = createContext<EditorGuard | null>(null);

/** Only transient editors register here; the shared settings document keeps its own draft. */
export function useSettingsEditorGuards() {
  const editors = useRef(new Set<() => EditorDraft>());
  const [, setRevision] = useState(0);
  const [transition, setTransition] = useState<(() => void) | null>(null);
  const notify = useCallback(() => setRevision((revision) => revision + 1), []);
  const read = useCallback(() => Array.from(editors.current, (editor) => editor()), []);
  const busy = useCallback(() => read().some((editor) => editor.busy || editor.pendingRef?.current), [read]);
  const dirty = useCallback(() => read().some((editor) => editor.dirty), [read]);
  const register = useCallback((editor: () => EditorDraft) => {
    editors.current.add(editor);
    notify();
    return () => {
      editors.current.delete(editor);
      notify();
    };
  }, [notify]);
  const discard = useCallback(() => {
    if (busy()) return;
    for (const editor of read()) editor.discard();
  }, [busy, read]);
  const request = useCallback((next: () => void) => {
    if (busy()) return;
    if (dirty()) setTransition(() => next);
    else next();
  }, [busy, dirty]);
  const context = useMemo(() => ({ register, notify, busy, request }), [register, notify, busy, request]);

  return {
    context,
    busy,
    dirty,
    discard,
    labels: read().filter((editor) => editor.dirty).map((editor) => editor.label),
    transition,
    cancel: () => setTransition(null),
    confirm: () => {
      if (busy()) return;
      discard();
      setTransition(null);
      transition?.();
    }
  };
}

export function useTransientSettingsEditor(draft: EditorDraft): void {
  const guard = useContext(SettingsEditorGuardContext);
  const current = useRef(draft);
  current.current = draft;
  useLayoutEffect(() => guard?.register(() => current.current), [guard]);
  useLayoutEffect(() => { guard?.notify(); }, [guard, draft.dirty, draft.busy]);
}

export function useSettingsEditorTransition(): (transition: () => void) => void {
  const guard = useContext(SettingsEditorGuardContext);
  return guard?.request ?? ((transition) => transition());
}

export function useSettingsEditorBusy(): boolean {
  return useContext(SettingsEditorGuardContext)?.busy() ?? false;
}
