import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {BEFORE_NAVIGATE, type NavigationRequest} from '../app/navigation-guard';
import {ConfirmDialog} from '../shell/ConfirmDialog';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {BEFORE_ARTIFACT_CHANGE, type ArtifactChangeRequest} from './artifact-interactions';

type EditorStatus = {
  label: string;
  dirty: boolean | (() => boolean);
  pending: boolean | (() => boolean);
  /** Window-local drafts can survive closing the inspector, but not window unload. */
  unloadDirty?: boolean;
};
type Transition = {run: () => void; message: string};
type EditorGuard = {
  register: (id: symbol, read: () => EditorStatus) => () => void;
  notify: () => void;
  locked: (except?: symbol) => boolean;
  busy: () => boolean;
  request: (run: () => void, message?: string) => void;
};
const Context = createContext<{guard: EditorGuard; revision: number} | null>(null);
const pending = (editor: EditorStatus): boolean =>
  typeof editor.pending === 'function' ? editor.pending() : editor.pending;
const dirty = (editor: EditorStatus): boolean =>
  typeof editor.dirty === 'function' ? editor.dirty() : editor.dirty;

/** One boundary owns close, native unload, project navigation and shell selection changes. */
export function ArtifactEditorBoundary({projectId, children}: {
  projectId: string; children: React.ReactNode
}): React.JSX.Element {
  const editors = useRef(new Map<symbol, () => EditorStatus>());
  const [revision, setRevision] = useState(0);
  const [transition, setTransition] = useState<Transition | null>(null);
  const transitionRef = useRef<Transition | null>(null);
  const notify = useCallback(() => setRevision(value => value + 1), []);
  const read = useCallback(() => Array.from(editors.current.values(), get => get()), []);
  const busy = useCallback(() => read().some(pending), [read]);
  const locked = useCallback((except?: symbol) => Array.from(editors.current)
    .some(([id, get]) => id !== except && (dirty(get()) || pending(get()))), []);
  const register = useCallback((id: symbol, get: () => EditorStatus) => {
    editors.current.set(id, get); notify();
    return () => {editors.current.delete(id); notify();};
  }, [notify]);
  const request = useCallback((run: () => void, message = '继续将放弃当前工件中尚未保存的修改。') => {
    if (busy()) return;
    if (!read().some(dirty)) {run(); return;}
    const next = {run, message};
    transitionRef.current = next; setTransition(next);
  }, [busy, read]);
  const guard = useMemo(() => ({register, notify, locked, busy, request}), [register, notify, locked, busy, request]);
  useEffect(() => {
    const beforeNavigate = (event: Event): void => {
      const navigation = event as CustomEvent<NavigationRequest>;
      if (navigation.detail.next.projectId === projectId) return;
      if (busy()) {event.preventDefault(); return;}
      if (read().some(dirty)) request(navigation.detail.defer());
    };
    const beforeChange = (event: Event): void => {
      const change = event as CustomEvent<ArtifactChangeRequest>;
      if (busy()) {event.preventDefault(); return;}
      if (read().some(dirty)) request(change.detail.defer());
    };
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!busy() && !read().some(editor => dirty(editor) || editor.unloadDirty)) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener(BEFORE_NAVIGATE, beforeNavigate);
    window.addEventListener(BEFORE_ARTIFACT_CHANGE, beforeChange);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener(BEFORE_NAVIGATE, beforeNavigate);
      window.removeEventListener(BEFORE_ARTIFACT_CHANGE, beforeChange);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [busy, projectId, read, request]);
  return <Context.Provider value={{guard, revision}}>
    {children}
    <ConfirmDialog open={transition !== null} title="放弃未保存的工件修改？"
      message={transition?.message ?? ''} confirmLabel="放弃修改并继续" tone="destructive"
      confirmDisabled={busy()} testId="artifact-draft-discard"
      onCancel={() => {transitionRef.current = null; setTransition(null);}}
      onConfirm={() => {
        if (busy()) return;
        const next = transitionRef.current;
        transitionRef.current = null; setTransition(null);
        next?.run();
      }} />
  </Context.Provider>;
}

export function useArtifactEditorGuard(): EditorGuard {
  const context = useContext(Context);
  if (context === null) throw new Error('artifact_editor_boundary_required');
  return context.guard;
}

export function useArtifactEditorStatus(status: EditorStatus): {locked: boolean; isLocked: () => boolean} {
  const guard = useArtifactEditorGuard();
  const id = useRef(Symbol('artifact-editor'));
  const current = useRef(status);
  current.current = status;
  useLayoutEffect(() => guard.register(id.current, () => current.current), [guard]);
  useLayoutEffect(() => {guard.notify();}, [guard, dirty(status),
    typeof status.pending === 'boolean' ? status.pending : status.pending(), status.unloadDirty]);
  return {locked: guard.locked(id.current), isLocked: () => guard.locked(id.current)};
}

/** Compare authored fields to their saved baseline, independent of reveal/navigation state. */
export function useArtifactDraft(label: string, value: unknown, busy: React.RefObject<boolean>): {
  dirty: boolean; locked: boolean; isLocked: () => boolean; saved: () => void; reset: (value: unknown) => void
} {
  const signature = JSON.stringify(value);
  const [, update] = useState(0);
  const current = useRef(signature);
  current.current = signature;
  const clean = useRef(signature);
  const dirty = signature !== clean.current;
  const status = useArtifactEditorStatus({label, dirty: () => current.current !== clean.current, pending: () => busy.current});
  const guard = useArtifactEditorGuard();
  const reset = (next: unknown): void => {
    clean.current = JSON.stringify(next); update(value => value + 1); guard.notify();
  };
  return {...status, dirty, reset, saved: () => {
    clean.current = current.current; update(value => value + 1); guard.notify();
  }};
}

/** Legacy child editors report activity synchronously before their first IPC call. */
export function useArtifactEditorActivity(label: string): {
  pending: boolean; dirty: boolean; locked: boolean; isLocked: () => boolean;
  setPending: (value: boolean) => void; setDirty: (value: boolean) => void
} {
  const [state, setState] = useState({pending: false, dirty: false});
  const current = useRef(state);
  const setPending = useCallback((pending: boolean) => {
    current.current = {...current.current, pending}; setState(current.current);
  }, []);
  const setDirty = useCallback((dirty: boolean) => {
    current.current = {...current.current, dirty}; setState(current.current);
  }, []);
  const status = useArtifactEditorStatus({label, pending: () => current.current.pending, dirty: () => current.current.dirty});
  return {...state, ...status, setPending, setDirty};
}

export function ArtifactDraftDiscard({dirty, onDiscard, testId}: {
  dirty: boolean; onDiscard: () => void; testId: string
}): React.JSX.Element | null {
  const guard = useArtifactEditorGuard();
  if (!dirty) return null;
  return <button type="button" className={`${formSecondaryButtonClass} border-[0.5px] self-start`}
    disabled={guard.busy()} data-testid={testId}
    onClick={() => guard.request(onDiscard, '此编辑器中尚未保存的修改将被放弃。')}>
    放弃未保存修改
  </button>;
}
