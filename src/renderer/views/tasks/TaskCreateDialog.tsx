import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { modalBackdropFade, modalPop, modalPopTransition, resolveMotionTransition } from '../../animations';
import { focusDialogInitialElement, trapDialogTabFocus } from '../../dialog-focus';
import { Button, TextArea } from '../../components/ui';

export function TaskCreateDialog({
  open,
  onClose,
  onExitComplete,
  onSubmitDescription
}: {
  open: boolean;
  onClose: () => void;
  onExitComplete: () => void;
  onSubmitDescription: (description: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}): React.JSX.Element {
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDescription('');
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open || panelRef.current === null) {
      return;
    }
    focusDialogInitialElement(panelRef.current, descriptionRef.current);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleKey(event: KeyboardEvent): void {
      if (panelRef.current !== null && trapDialogTabFocus(panelRef.current, event)) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  async function submit(): Promise<void> {
    const trimmedDescription = description.trim();
    if (trimmedDescription.length === 0) {
      setError('请输入任务描述。');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmitDescription(trimmedDescription);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDescription('');
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AnimatePresence onExitComplete={onExitComplete}>
      {open ? (
        <motion.div
          animate="animate"
          className="task-create-dialog-backdrop"
          data-testid="task-create-dialog-backdrop"
          exit="exit"
          initial="initial"
          onClick={onClose}
          role="presentation"
          transition={resolveMotionTransition({ duration: 0.16 })}
          variants={modalBackdropFade}
        >
          <motion.div
            animate="animate"
            aria-label="新建任务"
            aria-modal="true"
            className="task-create-dialog-panel"
            data-testid="task-create-dialog-panel"
            exit="exit"
            initial="initial"
            onClick={(event) => event.stopPropagation()}
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
            transition={resolveMotionTransition(modalPopTransition)}
            variants={modalPop}
          >
            <div className="task-create-dialog-shell" data-testid="task-create-dialog-shell">
              <div className="task-create-dialog" data-testid="task-create-dialog">
                <header className="task-create-dialog-header">
                  <div className="task-create-dialog-heading">
                    <span className="task-create-dialog-kicker">Task Control</span>
                    <h2 className="task-create-dialog-title">新建任务</h2>
                    <p className="task-create-dialog-copy">描述你想要的后台任务，由 AI 生成并创建。</p>
                  </div>
                  <button
                    aria-label="关闭新建任务"
                    className="task-create-dialog-close"
                    data-testid="task-create-dialog-close"
                    onClick={onClose}
                    type="button"
                  >
                    ×
                  </button>
                </header>
                <div className="task-create-dialog-body">
                  <section className="task-create-section">
                    <div className="task-create-section-head">
                      <h3>任务描述</h3>
                      <p>写下目标、触发时机、工作区和动作边界；缺失的信息会由 AI 按保守规则补齐。</p>
                    </div>
                    <div className="task-create-form-grid">
                      <label className="task-form-field task-form-field--wide">
                        <span>自然语言描述</span>
                        <TextArea
                          data-testid="task-create-description"
                          ref={descriptionRef}
                          rows={8}
                          value={description}
                          onChange={(event) => {
                            setDescription(event.target.value);
                            setError(null);
                          }}
                        />
                      </label>
                    </div>
                  </section>
                  {error === null ? null : <span className="pill warn" data-testid="task-create-error">{error}</span>}
                </div>
                <div className="task-create-dialog-actions action-strip">
                  <Button data-testid="task-create-submit" onClick={() => void submit()} disabled={submitting} variant="primary">
                    {submitting ? '提交中' : '创建任务'}
                  </Button>
                  <Button onClick={onClose}>关闭</Button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
