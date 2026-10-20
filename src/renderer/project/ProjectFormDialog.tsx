import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { ResearchProject } from '../../shared/types';
import { truncateMiddle } from '../shared/format';
import { ModalShell } from '../shell/ModalShell';
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

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;

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
    errors.description = '请填写研究目标：它决定阶段运行与闸门判断的依据。';
  } else if (description.length > DESCRIPTION_MAX) {
    errors.description = `研究目标不能超过 ${DESCRIPTION_MAX} 个字符。`;
  }
  if (mode === 'create' && values.workspacePath.trim().length === 0) {
    errors.workspacePath = '请选择工作目录。一个目录同时只属于一个项目。';
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
  const [values, setValues] = useState<ProjectFormValues>({
    title: '',
    description: '',
    language: 'zh',
    workspacePath: ''
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  // Failure of the native panel is its own error line: collapsing it into
  // "nothing happened" would be a silent failure.
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Re-seed whenever the dialog opens or targets a different project, so a
  // cancelled edit leaves nothing behind. Keyed on the id, not the object, so a
  // parent passing a fresh object each render cannot wipe what the user typed.
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!open) {
      return;
    }
    setValues({
      title: project?.title ?? '',
      description: project?.description ?? '',
      language: project?.language ?? 'zh',
      workspacePath: project?.workspacePath ?? ''
    });
    setErrors({});
    setWorkspaceError(null);
    // `project` is intentionally not a dependency; the id is the identity that
    // matters. See the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  const pickWorkspace = async (): Promise<void> => {
    setPickingWorkspace(true);
    setWorkspaceError(null);
    try {
      const result = await onPickWorkspace();
      if (result.status === 'failed') {
        setWorkspaceError(result.message);
        return;
      }
      if (result.status === 'cancelled') {
        return;
      }
      setValues((current) => ({ ...current, workspacePath: result.path }));
      setErrors((current) => ({ ...current, workspacePath: undefined }));
    } finally {
      setPickingWorkspace(false);
    }
  };

  const submit = (): void => {
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

  return (
    <ModalShell
      open={open}
      title={mode === 'create' ? '新建研究项目' : '编辑研究项目'}
      onClose={onCancel}
      widthClassName="w-[560px]"
      testId={mode === 'create' ? 'portal-create-dialog' : 'portal-edit-dialog'}
      initialFocusRef={titleRef}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted text-[var(--font-meta-size)]">标题</span>
          <input
            ref={titleRef}
            value={values.title}
            onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
            aria-invalid={errors.title !== undefined}
            data-testid="project-form-title"
            className="h-[var(--control-height)] rounded-control border border-line bg-surface-strong px-2.5 text-ink"
          />
          {errors.title === undefined ? null : (
            <span role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]" data-testid="project-form-title-error">
              {errors.title}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted text-[var(--font-meta-size)]">研究目标</span>
          <textarea
            value={values.description}
            rows={4}
            onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))}
            aria-invalid={errors.description !== undefined}
            data-testid="project-form-description"
            className="resize-none rounded-control border border-line bg-surface-strong px-2.5 py-2 text-ink"
          />
          <span className="text-subtle text-[var(--font-micro-size)]">
            阶段运行与闸门判断都以它为依据；未写明运行时指令时也用它。
          </span>
          {errors.description === undefined ? null : (
            <span role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]" data-testid="project-form-description-error">
              {errors.description}
            </span>
          )}
        </label>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-muted text-[var(--font-meta-size)]">文稿语言</legend>
          <div role="radiogroup" aria-label="文稿语言" className="flex items-center gap-1">
            {(
              [
                { value: 'zh' as const, label: '中文' },
                { value: 'en' as const, label: '英文' }
              ]
            ).map((option) => {
              const selected = values.language === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={languageLocked}
                  onClick={() => setValues((current) => ({ ...current, language: option.value }))}
                  data-testid={`project-form-language-${option.value}`}
                  className={
                    selected
                      ? 'h-[var(--control-height-compact)] rounded-control bg-accent-soft px-2.5 text-ink active:bg-[var(--accent-soft-strong)] disabled:opacity-60'
                      : 'h-[var(--control-height-compact)] rounded-control px-2.5 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-60'
                  }
                >
                  <span className="text-[var(--font-meta-size)]">{option.label}</span>
                </button>
              );
            })}
          </div>
          {languageLocked ? (
            <span className="text-subtle text-[var(--font-micro-size)]">创建后不可更改。</span>
          ) : null}
        </fieldset>

        <div className="flex flex-col gap-1">
          <span className="text-muted text-[var(--font-meta-size)]">工作目录</span>
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate rounded-control border border-line bg-bg-soft px-2.5 py-1.5 font-mono text-[var(--font-meta-size)]"
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
              disabled={pickingWorkspace}
              data-testid="project-form-pick-workspace"
              className="flex h-[var(--control-height)] shrink-0 items-center gap-1.5 rounded-control border border-line px-2.5 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50"
            >
              <FolderOpen size={13} aria-hidden="true" />
              选择目录
            </button>
          </div>
          <span className="text-subtle text-[var(--font-micro-size)]">
            必须用系统目录选择器；一个目录同时只属于一个项目。
          </span>
          {errors.workspacePath === undefined ? null : (
            <span role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]" data-testid="project-form-workspace-error">
              {errors.workspacePath}
            </span>
          )}
          {workspaceError === null ? null : (
            <span role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]" data-testid="project-form-workspace-pick-error">
              {workspaceError}
            </span>
          )}
        </div>

        {submitError === null ? null : (
          <p role="alert" className="rounded-card border border-[var(--st-bad-line)] px-2.5 py-1.5 text-[var(--st-bad)]" data-testid="project-form-error">
            {submitError}
          </p>
        )}

        <div className="mt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="project-form-cancel"
            className="h-[var(--control-height)] rounded-control border border-line px-3 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={pending}
            data-testid="project-form-submit"
            className="h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)] disabled:opacity-50"
          >
            {pending ? '正在保存…' : mode === 'create' ? '创建' : '保存'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
