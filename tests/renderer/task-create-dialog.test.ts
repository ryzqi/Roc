// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCreateDialog } from '../../src/renderer/views/tasks/TaskCreateDialog';

describe('TaskCreateDialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders only the natural language description controls when open', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskCreateDialog, {
        open: true,
        onClose: () => {},
        onExitComplete: () => {},
        onSubmitDescription: async () => ({ ok: true as const })
      })
    );

    expect(html).toContain('data-testid="task-create-dialog-backdrop"');
    expect(html).toContain('data-testid="task-create-dialog-panel"');
    expect(html).toContain('data-testid="task-create-dialog-close"');
    expect(html).toContain('data-testid="task-create-dialog"');
    expect(html).toContain('data-testid="task-create-description"');
    expect(html).toContain('data-testid="task-create-submit"');
    expect(html).toContain('由 AI 生成并创建');
    expect(html).toContain('创建任务');
    expect(html).not.toContain('生成任务提议');
    expect(html).not.toContain('待审批提议');
    expect(html).not.toContain('data-testid="task-create-goal"');
    expect(html).not.toContain('data-testid="task-create-trigger-type"');
    expect(html).not.toContain('data-testid="task-create-workspace-path"');
    expect(html).not.toContain('data-testid="task-create-allowed-actions"');
    expect(html).not.toContain('data-testid="task-create-forbidden-actions"');
  });

  it('marks the panel as a modal dialog for assistive technology', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskCreateDialog, {
        open: true,
        onClose: () => {},
        onExitComplete: () => {},
        onSubmitDescription: async () => ({ ok: true as const })
      })
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="新建任务"');
  });

  it('moves initial focus to the description field', async () => {
    await renderDialog();

    expect(document.activeElement).toBe(queryTextarea('task-create-description'));
  });

  it('keeps Tab focus inside the dialog panel', async () => {
    await renderDialog();

    const headerClose = queryButton('task-create-dialog-close');
    const footerClose = queryFooterCloseButton();

    footerClose.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(headerClose);

    headerClose.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, shiftKey: true }));
    });
    expect(document.activeElement).toBe(footerClose);
  });

  it('closes when Escape is pressed', async () => {
    const onClose = vi.fn();
    await renderDialog({ onClose });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not submit an empty description', async () => {
    const onSubmitDescription = vi.fn().mockResolvedValue({ ok: true as const });

    await renderDialog({
      onSubmitDescription
    });

    await act(async () => {
      queryButton('task-create-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmitDescription).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="task-create-error"]')?.textContent).toBe('请输入任务描述。');
  });

  it('submits a trimmed description and asks the parent to close after success', async () => {
    const onClose = vi.fn();
    const onSubmitDescription = vi.fn().mockResolvedValue({ ok: true as const });

    await renderDialog({
      onClose,
      onSubmitDescription
    });

    setTextareaValue('task-create-description', '  每天早上检查失败测试  ');

    await act(async () => {
      queryButton('task-create-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmitDescription).toHaveBeenCalledWith('每天早上检查失败测试');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and shows the submit error when AI task proposal fails', async () => {
    const onClose = vi.fn();

    await renderDialog({
      onClose,
      onSubmitDescription: vi.fn().mockResolvedValue({ ok: false as const, error: '默认模型未配置。' })
    });

    setTextareaValue('task-create-description', '检查项目状态');

    await act(async () => {
      queryButton('task-create-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="task-create-error"]')?.textContent).toBe('默认模型未配置。');
  });

  async function renderDialog(input?: {
    onClose?: () => void;
    onSubmitDescription?: (description: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  }): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(TaskCreateDialog, {
          open: true,
          onClose: input?.onClose ?? (() => {}),
          onExitComplete: () => {},
          onSubmitDescription: input?.onSubmitDescription ?? (async () => ({ ok: true as const }))
        })
      );
    });
  }

  function queryButton(testId: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  }

  function queryTextarea(testId: string): HTMLTextAreaElement {
    const textarea = container.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
    expect(textarea).not.toBeNull();
    return textarea as HTMLTextAreaElement;
  }

  function queryFooterCloseButton(): HTMLButtonElement {
    const footerClose = Array.from(container.querySelectorAll<HTMLButtonElement>('.task-create-dialog-actions button'))
      .find((button) => button.textContent === '关闭');
    expect(footerClose).not.toBeUndefined();
    return footerClose as HTMLButtonElement;
  }

  function setTextareaValue(testId: string, value: string): void {
    const textarea = container.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
    expect(textarea).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    expect(setter).not.toBeUndefined();
    setter?.call(textarea, value);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
