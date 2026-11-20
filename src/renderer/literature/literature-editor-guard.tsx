import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {BEFORE_NAVIGATE, type NavigationRequest} from '../app/navigation-guard';
import {ConfirmDialog} from '../shell/ConfirmDialog';
import {BEFORE_READING_CHANGE, type ReadingChangeRequest} from './reading-interactions';

type Editor = {label: string; dirty: () => boolean; busy: () => boolean; discard: () => void};
type Transition = {run: () => void; message: string};
type Guard = {
  register: (read: () => Editor) => () => void;
  notify: () => void;
  busy: () => boolean;
  request: (run: () => void, message?: string) => void;
};
const Context = createContext<{guard: Guard; revision: number} | null>(null);

/** The source panel owns its forms; all navigation deferrals must release independently. */
export function LiteratureEditorBoundary({projectId, children, protectReadingChange = true}: {
  projectId: string; children: React.ReactNode; protectReadingChange?: boolean;
}): React.JSX.Element {
  const editors = useRef(new Set<() => Editor>());
  const [revision, setRevision] = useState(0);
  const [transition, setTransition] = useState<Transition | null>(null);
  const currentTransition = useRef<Transition | null>(null);
  const read = useCallback(() => Array.from(editors.current, get => get()), []);
  const notify = useCallback(() => setRevision(value => value + 1), []);
  const busy = useCallback(() => read().some(editor => editor.busy()), [read]);
  const register = useCallback((get: () => Editor) => {
    editors.current.add(get); notify();
    return () => {editors.current.delete(get); notify();};
  }, [notify]);
  const request = useCallback((run: () => void, message = '继续将放弃当前面板中尚未保存的录入和原请求。') => {
    if (busy()) return;
    if (!read().some(editor => editor.dirty())) {run(); return;}
    const next = {run, message};
    currentTransition.current = next; setTransition(next);
  }, [busy, read]);
  const guard = useMemo(() => ({register, notify, busy, request}), [register, notify, busy, request]);
  useEffect(() => {
    const protect = (event: Event, defer: () => () => void): void => {
      if (busy()) {event.preventDefault(); return;}
      if (!read().some(editor => editor.dirty())) return;
      const resume = defer();
      request(() => {
        for (const editor of read()) if (editor.dirty()) editor.discard();
        resume();
      });
    };
    const navigate = (event: Event): void => {
      const change = (event as CustomEvent<NavigationRequest>).detail;
      if (change.next.projectId !== projectId) protect(event, change.defer);
    };
    const selection = (event: Event): void => {
      const change = (event as CustomEvent<ReadingChangeRequest>).detail;
      if (protectReadingChange && change.projectId === projectId) protect(event, change.defer);
    };
    const unload = (event: BeforeUnloadEvent): void => {
      if (!busy() && !read().some(editor => editor.dirty())) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener(BEFORE_NAVIGATE, navigate);
    window.addEventListener(BEFORE_READING_CHANGE, selection);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener(BEFORE_NAVIGATE, navigate);
      window.removeEventListener(BEFORE_READING_CHANGE, selection);
      window.removeEventListener('beforeunload', unload);
      currentTransition.current = null;
    };
  }, [busy, projectId, protectReadingChange, read, request]);
  return <Context.Provider value={{guard, revision}}>
    {children}
    <ConfirmDialog open={transition !== null} title="放弃未保存的文献录入？"
      message={transition?.message ?? ''} confirmLabel="放弃录入并继续" cancelLabel="继续编辑"
      tone="destructive" confirmDisabled={busy()} testId="literature-editor-discard"
      onCancel={() => {currentTransition.current = null; setTransition(null);}}
      onConfirm={() => {
        if (busy()) return;
        const next = currentTransition.current;
        currentTransition.current = null; setTransition(null); next?.run();
      }}/>
  </Context.Provider>;
}

export function useLiteratureEditor(editor: Editor): Guard {
  const context = useContext(Context);
  if (context === null) throw new Error('literature_editor_boundary_required');
  const {guard} = context;
  const current = useRef(editor); current.current = editor;
  useLayoutEffect(() => guard.register(() => current.current), [guard]);
  useLayoutEffect(() => {guard.notify();}, [guard, editor.dirty(), editor.busy()]);
  return guard;
}
