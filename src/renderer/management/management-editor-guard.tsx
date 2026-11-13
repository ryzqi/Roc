import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BEFORE_NAVIGATE, type NavigationRequest } from '../app/navigation-guard';
import type {AppViewId} from '../app/routes';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { BEFORE_MANAGEMENT_EDITOR_CHANGE, type ManagementEditorChange } from './management-interactions';

type Editor = {
  label: string;
  dirty: () => boolean;
  busy: () => boolean;
  discard: () => void;
};
type Guard = {
  register: (read: () => Editor) => () => void;
  notify: () => void;
  busy: () => boolean;
};
const Context = createContext<{ guard: Guard; revision: number } | null>(null);

/** Transient task facts live in the section; shared memory/MCP/task stores keep their own guard. */
export function ManagementEditorBoundary({ projectId, canvasView, children }: {
  projectId: string; canvasView?: AppViewId | undefined; children: React.ReactNode;
}): React.JSX.Element {
  const editors = useRef(new Set<() => Editor>());
  const [revision, setRevision] = useState(0);
  const [continuation, setContinuation] = useState<(() => void) | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const read = useCallback(() => Array.from(editors.current, get => get()), []);
  const notify = useCallback(() => setRevision(value => value + 1), []);
  const busy = useCallback(() => read().some(editor => editor.busy()), [read]);
  const register = useCallback((get: () => Editor) => {
    editors.current.add(get);
    notify();
    return () => { editors.current.delete(get); notify(); };
  }, [notify]);
  const guard = useMemo(() => ({ register, notify, busy }), [register, notify, busy]);

  useEffect(() => {
    const defer = (event: Event, request: ManagementEditorChange): void => {
      if (busy()) { event.preventDefault(); return; }
      if (!read().some(editor => editor.dirty())) return;
      const resume = request.defer();
      pending.current = resume;
      setContinuation(() => resume);
    };
    const change = (event: Event): void => defer(event, (event as CustomEvent<ManagementEditorChange>).detail);
    const navigate = (event: Event): void => {
      const request = (event as CustomEvent<NavigationRequest>).detail;
      if (request.next.projectId !== projectId || (canvasView !== undefined && request.next.view !== canvasView)) {
        defer(event, request);
      }
    };
    const unload = (event: BeforeUnloadEvent): void => {
      if (!busy() && !read().some(editor => editor.dirty())) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener(BEFORE_MANAGEMENT_EDITOR_CHANGE, change);
    window.addEventListener(BEFORE_NAVIGATE, navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener(BEFORE_MANAGEMENT_EDITOR_CHANGE, change);
      window.removeEventListener(BEFORE_NAVIGATE, navigate);
      window.removeEventListener('beforeunload', unload);
      pending.current = null;
    };
  }, [busy, projectId, canvasView, read]);

  return <Context.Provider value={{ guard, revision }}>
    {children}
    <ConfirmDialog open={continuation !== null} title="放弃未保存的管理改动？"
      message={`${read().filter(editor => editor.dirty()).map(editor => editor.label).join('、')} 尚未保存。`}
      detail="继续将放弃这些录入。"
      confirmLabel="放弃修改并继续" cancelLabel="继续编辑" tone="destructive"
      confirmDisabled={busy()} testId="mgmt-editor-discard"
      onCancel={() => { pending.current = null; setContinuation(null); }}
      onConfirm={() => {
        if (busy()) return;
        const resume = pending.current;
        pending.current = null;
        setContinuation(null);
        for (const editor of read()) editor.discard();
        resume?.();
      }} />
  </Context.Provider>;
}

export function useManagementEditor(): Guard {
  const context = useContext(Context);
  if (context === null) throw new Error('management_editor_boundary_required');
  return context.guard;
}

export function useManagementEditorDraft(editor: Editor): void {
  const guard = useManagementEditor();
  const current = useRef(editor);
  current.current = editor;
  useLayoutEffect(() => guard.register(() => current.current), [guard]);
  useLayoutEffect(() => { guard.notify(); }, [guard, editor.dirty(), editor.busy()]);
}
