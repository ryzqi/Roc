import { useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import type { ResearchProject } from '../../shared/types';
import { truncateMiddle } from '../shared/format';
import { ModalShell } from '../shell/ModalShell';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { errorMessage } from '../app/loaded-state';
import { formButtonClass, formPrimaryButtonClass } from '../shared/form-ui';
import type { WorkspacePickResult } from './use-projects';

/**
 * Create / edit project dialog (P2/T2.3, T2.4).
 *
 * One component for both modes so the field rules cannot drift between them.
 *
 * Contract facts that shape the form (from `researchProjectCreateRequestSchema`
 * and `researchProjectUpdateRequestSchema`):
 *   - `description` (研究目标) is **required**, 1–5000 chars — not optional
 *   - `title` is 1–200 chars
 *   - `workspacePath` is required on create and must come from the native panel;
 *     typing a path is impossible, and the field is read-only when bound
 *   - `language` is accepted by `update` on the backend, but the product keeps it
 *     fixed after creation, so the control is disabled in edit mode and the
 *     reason is stated rather than silently ignoring a change
 *
 * Client-side validation mirrors the schema so obvious mistakes never round-trip;
 * anything the backend rejects (directory already taken, not writable) is shown
 * as the form's error line with the backend's own wording.
 */

export type ProjectFormValues = {
  title: string;
  description: string;
  language: 'zh' | 'en';
  workspacePath: string;
};

export type ProjectFormDialogProps = {
  open: boolean;
  mode: 'create' | 'edit';
  project?: ResearchProject | null;
  pending: boolean;
  submitError: string | null;
  onCancel: () => void;
  onSubmit: (values: ProjectFormValues) => void;
  /** Opens the native directory panel. Distinguishes cancel from failure. */
  onPickWorkspace: () => Promise<WorkspacePickResult>;
};

type FieldErrors = Partial<Record<'title' | 'description' | 'workspacePath', string>>;

const emptyValues: ProjectFormValues = { title: '', description: '', language: 'zh', workspacePath: '' };

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;
const LANGUAGES = [
  { value: 'zh' as const, label: '中文' },
  { value: 'en' as const, label: '英文' }
];

function validate(values: ProjectFormValues, mode: 'create' | 'edit'): FieldErrors {
  const errors: FieldErrors = {};
  const title = values.title.trim();
  if (title.length === 0) {
    errors.title = '请填写标题。';
  } else if (title.length > TITLE_MAX) {
    errors.title = `标题不能超过 ${TITLE_MAX} 个字符。`;
  }
  const description = values.description.trim();
  if (description.length === 0) {
    errors.description = '请填写研究目标。';
  } else if (description.length > DESCRIPTION_MAX) {
    errors.description = `研究目标不能超过 ${DESCRIPTION_MAX} 个字符。`;
  }
  if (mode === 'create' && values.workspacePath.trim().length === 0) {
    errors.workspacePath = '请选择工作目录。';
  }
  return errors;
}

export function ProjectFormDialog({
  open,
  mode,
  project = null,
  pending,
  submitError,
  onCancel,
  onSubmit,
  onPickWorkspace
}: ProjectFormDialogProps): React.JSX.Element {
  const [values, setValues] = useState(emptyValues);
  const initialValues = useRef(emptyValues);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const formId = useId();
  const titleErrorId = useId();
  const descriptionErrorId = useId();
  // Failure of the native panel is its own error line: collapsing it into
  // "nothing happened" would be a silent failure.
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const languageRefs = useRef<Partial<Record<ProjectFormValues['language'], HTMLButtonElement | null>>>({});
  const pickerGeneration = useRef(0);
  const pickingRef = useRef(false);

  // Re-seed whenever the dialog opens or targets a different project, so a
  // cancelled edit leaves nothing behind. Keyed on the id, not the object, so a
  // parent passing a fresh object each render cannot wipe what the user typed.
  const projectId = project?.id ?? null;
  useEffect(() => {
    pickerGeneration.current++;
    pickingRef.current = false;
    setPickingWorkspace(false);
    setDiscardOpen(false);
    if (open) {
      const initial: ProjectFormValues = {
        title: project?.title ?? '',
        description: project?.description ?? '',
        language: project?.language ?? 'zh',
        workspacePath: project?.workspacePath ?? ''
      };
      initialValues.current = initial;
      setValues(initial);
      setErrors({});
      setWorkspaceError(null);
    }
    return () => {
      pickerGeneration.current++;
      pickingRef.current = false;
    };
    // `project` is intentionally not a dependency; the id is the identity that
    // matters. See the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, mode]);

  const pickWorkspace = async (): Promise<void> => {
    if (!open || pending || pickingRef.current) return;
    const generation = pickerGeneration.current;
    pickingRef.current = true;
    setPickingWorkspace(true);
    setWorkspaceError(null);
    try {
      const result = await onPickWorkspace();
      if (generation !== pickerGeneration.current) return;
      if (result.status === 'failed') {
        setWorkspaceError(result.message);
        return;
      }
      if (result.status === 'cancelled') {
        return;
      }
      setValues((current) => ({ ...current, workspacePath: result.path }));
      setErrors((current) => ({ ...current, workspacePath: undefined }));
    } catch (error) {
      if (generation === pickerGeneration.current) setWorkspaceError(errorMessage(error));
    } finally {
      if (generation === pickerGeneration.current) {
        pickingRef.current = false;
        setPickingWorkspace(false);
      }
    }
  };

  const submit = (): void => {
    if (pending || pickingRef.current) return;
    const found = validate(values, mode);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    onSubmit({
      title: values.title.trim(),
      description: values.description.trim(),
      language: values.language,
      workspacePath: values.workspacePath.trim()
    });
  };

  const languageLocked = mode === 'edit';
  const busy = pending || pickingWorkspace;
  const beforeClose = (): boolean => {
    if (busy) return false;
    const initial = initialValues.current;
    if (values.title === initial.title && values.description === initial.description &&
        values.language === initial.language && values.workspacePath === initial.workspacePath) {
      return true;
    }
    setDiscardOpen(true);
    return false;
  };

  return (
    <>
    <ModalShell
      closeOnBackdrop={false}
      open={open}
      title={mode === 'create' ? '新建研究项目' : '编辑研究项目'}
      onClose={onCancel}
      beforeClose={beforeClose}
      closeDisabled={busy}
      widthClassName="w-[520px]"
      testId={mode === 'create' ? 'portal-create-dialog' : 'portal-edit-dialog'}
      initialFocusRef={titleRef}
      footer={<>
        {submitError === null ? null : (
          <p role="alert" className="basis-full wrap-anywhere text-st-bad" data-testid="project-form-error">{submitError}</p>
        )}
        <button type="button" onClick={() => { if (beforeClose()) onCancel(); }} disabled={busy}
          data-testid="project-form-cancel" className={formButtonClass}>
          取消
        </button>
        <button type="submit" form={formId} disabled={busy} aria-busy={pending}
          data-testid="project-form-submit" className={formPrimaryButtonClass}>
          {pending ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {pending ? '正在保存…' : mode === 'create' ? '创建项目' : '保存修改'}
        </button>
      </>}
    >
      <form
        id={formId}
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted text-[length:var(--font-meta-size)]">标题</span>
          <input
            ref={titleRef}
            value={values.title}
            disabled={busy}
            onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
            onBlur={() => {
              if (values.title !== initialValues.current.title || errors.title !== undefined) {
                setErrors((current) => ({ ...current, title: validate(values, mode).title }));
              }
            }}
            aria-invalid={errors.title !== undefined}
            aria-describedby={errors.title === undefined ? undefined : titleErrorId}
            data-testid="project-form-title"
            className="h-[var(--control-height)] rounded-control border-[0.5px] border-line bg-surface-strong px-2 text-ink"
          />
          {errors.title === undefined ? null : (
            <span id={titleErrorId} role="alert" className="text-st-bad text-[length:var(--font-meta-size)]" data-testid="project-form-title-error">
              {errors.title}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted text-[length:var(--font-meta-size)]">研究目标</span>
          <textarea
            value={values.description}
            disabled={busy}
            rows={4}
            onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))}
            onBlur={() => {
              if (values.description !== initialValues.current.description || errors.description !== undefined) {
                setErrors((current) => ({ ...current, description: validate(values, mode).description }));
              }
            }}
            aria-invalid={errors.description !== undefined}
            aria-describedby={errors.description === undefined ? undefined : descriptionErrorId}
            data-testid="project-form-description"
            className="resize-none rounded-control border-[0.5px] border-line bg-surface-strong px-2 py-2 text-ink"
          />
          {errors.description === undefined ? null : (
            <span id={descriptionErrorId} role="alert" className="text-st-bad text-[length:var(--font-meta-size)]" data-testid="project-form-description-error">
              {errors.description}
            </span>
          )}
        </label>

        <fieldset className="flex flex-col gap-1" title={languageLocked ? '创建后不可更改' : undefined}>
          <legend className="text-muted text-[length:var(--font-meta-size)]">文稿语言</legend>
          <div
            role="radiogroup"
            aria-label="文稿语言"
            className="flex items-center gap-1"
            onKeyDown={(event) => {
              if (busy || languageLocked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              const next = values.language === 'zh' ? 'en' : 'zh';
              setValues((current) => ({ ...current, language: next }));
              languageRefs.current[next]?.focus();
            }}
          >
            {LANGUAGES.map((option) => {
              const selected = values.language === option.value;
              return (
                <button
                  key={option.value}
                  ref={(element) => { languageRefs.current[option.value] = element; }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={languageLocked || busy}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setValues((current) => ({ ...current, language: option.value }))}
                  data-testid={`project-form-language-${option.value}`}
                  className={
                    selected
                      ? 'min-h-[var(--control-height-compact)] rounded-control bg-[var(--overlay-active)] px-2 font-medium text-ink disabled:opacity-60'
                      : 'min-h-[var(--control-height-compact)] rounded-control px-2 text-muted enabled:hover:bg-[var(--overlay-hover)] enabled:hover:text-ink enabled:active:bg-[var(--overlay-active)] disabled:opacity-60'
                  }
                >
                  <span className="text-[length:var(--font-meta-size)]">{option.label}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1">
          <span className="text-muted text-[length:var(--font-meta-size)]">工作目录</span>
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate rounded-control border-[0.5px] border-line bg-bg-soft px-2 py-1 font-mono text-[length:var(--font-meta-size)]"
              title={values.workspacePath}
              data-testid="project-form-workspace"
            >
              {values.workspacePath.length === 0 ? (
                <span className="font-sans text-subtle">未选择</span>
              ) : (
                truncateMiddle(values.workspacePath, 48)
              )}
            </span>
            <button
              type="button"
              onClick={() => void pickWorkspace()}
              disabled={busy}
              data-testid="project-form-pick-workspace"
              aria-busy={pickingWorkspace}
              className="flex min-h-[var(--control-height)] shrink-0 items-center gap-2 rounded-control border-[0.5px] border-line px-2 text-ink enabled:hover:bg-[var(--overlay-hover)] enabled:active:bg-[var(--overlay-active)] disabled:opacity-50"
            >
              {pickingWorkspace ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> :
                <FolderOpen size={14} aria-hidden="true" />}
              选择目录
            </button>
          </div>
          {errors.workspacePath === undefined ? null : (
            <span role="alert" className="text-[var(--st-bad)] text-[length:var(--font-micro-size)]" data-testid="project-form-workspace-error">
              {errors.workspacePath}
            </span>
          )}
          {workspaceError === null ? null : (
            <span role="alert" className="text-[var(--st-bad)] text-[length:var(--font-micro-size)]" data-testid="project-form-workspace-pick-error">
              {workspaceError}
            </span>
          )}
        </div>

      </form>
    </ModalShell>
    <ConfirmDialog
      open={open && discardOpen}
      title="放弃项目草稿？"
      message="关闭后，未保存的项目改动将丢失。"
      confirmLabel="放弃草稿"
      cancelLabel="继续编辑"
      tone="destructive"
      testId="project-form-discard"
      onCancel={() => setDiscardOpen(false)}
      onConfirm={() => { setDiscardOpen(false); onCancel(); }}
    />
    </>
  );
}
