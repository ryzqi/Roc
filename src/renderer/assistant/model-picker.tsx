import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Settings2 } from 'lucide-react';

/**
 * 默认模型选择器（P10 把模型切换从助手头部挪到输入区下方）。
 *
 * ## 为什么是一个自绘的弹出层，而不是 `<select>`
 *
 * 选项要带 provider 分组、停用标记和「在设置里管理模型」入口，`<select>` 给不了这些；
 * 而 `ModalShell` 是**模态**层（会把 `#root` 对辅助技术设为 aria-hidden 并把 Tab 困在层内），
 * 用在这里会把整个助手和画布一起挡掉。所以这里是**非模态**浮层：不进 overlay 栈，
 * 只自己处理外部点击与 Escape，焦点在关闭时回到触发按钮。
 *
 * ## 键盘行为照搬原生 select 弹层
 *
 * 打开即把焦点放进选项列表（当前项）→ ↑/↓/Home/End 在选项间移动 →
 * Enter/Space 选中并关闭 → Escape 关闭并把焦点还给触发按钮 → Tab 离开即关闭。
 * 触发按钮仍是唯一的 Tab 停靠点（`aria-haspopup="listbox"` + `aria-expanded`），
 * 所以「先 Tab 到选择器、再按空格打开」在任何时候都成立。
 */

export type ModelChoice = {
  /** `provider:model`，与 `settings.defaultModelId` 同一格式。 */
  key: string;
  label: string;
  providerId: string;
  /** 分组标题（provider 显示名）。 */
  providerLabel: string;
  enabled: boolean;
};

export type ModelPickerProps = {
  choices: ModelChoice[];
  /** 当前默认模型的键；`null` 表示尚未配置。 */
  currentKey: string | null;
  /** 触发按钮上显示的文字（由上层统一格式化，空配置时是「模型未配置」）。 */
  label: string;
  /** 正在写后端；期间触发按钮禁用并显示转圈。 */
  pending: boolean;
  /** 上一次切换失败的原因。 */
  error: string | null;
  /** 读设置失败或尚无可用模型时，给出「去设置」这条唯一可行的路。 */
  onOpenSettings: () => void;
  onSelect: (key: string) => void;
};

export function ModelPicker({
  choices,
  currentKey,
  label,
  pending,
  error,
  onOpenSettings,
  onSelect
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /**
   * 已经提交过一次切换、正在等后端回来。
   *
   * 用来区分「刚打开、还没写」与「写完了」：只有后者才允许自动关浮层，否则
   * `pending === false && error === null` 这个初始状态会把浮层瞬间关掉。
   */
  const [submitted, setSubmitted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setSubmitted(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  // 写成功就关浮层并把焦点还给触发按钮；写失败就留在原地显示原因。
  useEffect(() => {
    if (!open || !submitted || pending) {
      return;
    }
    if (error === null) {
      close(true);
    } else {
      setSubmitted(false);
    }
  }, [close, error, open, pending, submitted]);

  // 外部点击关闭：`pointerdown` 而不是 `click`，否则在别处按下的那一下会先生效
  // （比如画布里的按钮），浮层才消失。
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && container.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // 打开后焦点进入当前项（没有当前项就是第一项）：弹出层若不给焦点，
  // 键盘用户按 ↑/↓ 什么也不会发生。
  useEffect(() => {
    if (!open) {
      return;
    }
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const options = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const selected = options.find((option) => option.getAttribute('aria-selected') === 'true');
    (selected ?? options[0])?.focus();
  }, [open]);

  const moveFocus = (direction: -1 | 1): void => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const options = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
    if (options.length === 0) {
      return;
    }
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = index === -1 ? 0 : (index + direction + options.length) % options.length;
    options[next]?.focus();
  };

  const providerGroups: Array<{ providerId: string; providerLabel: string; items: ModelChoice[] }> = [];
  for (const choice of choices) {
    const existing = providerGroups.find((group) => group.providerId === choice.providerId);
    if (existing === undefined) {
      providerGroups.push({ providerId: choice.providerId, providerLabel: choice.providerLabel, items: [choice] });
    } else {
      existing.items.push(choice);
    }
  }

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          // 写入中不打开：`disabled` 会让焦点从触发按钮上掉下去（切换后刚把焦点还回来），
          // 所以这里只是忽略点击，按钮本身仍可聚焦。
          if (pending) {
            return;
          }
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            close(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-busy={pending}
        aria-label={`默认模型：${label}`}
        title="切换默认模型"
        data-testid="assistant-model-settings"
        className="flex h-[var(--control-height-compact)] w-full min-w-0 items-center gap-1 rounded-control border border-line bg-surface px-2 text-left text-text text-[var(--font-micro-size)] transition-colors duration-[var(--duration-fast)] hover:border-line-strong hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {pending ? (
          <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin text-muted" />
        ) : (
          <Settings2 size={12} aria-hidden="true" className="shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium tracking-tight" title={label}>
          {label}
        </span>
        <ChevronDown size={11} aria-hidden="true" className="shrink-0 text-subtle" />
      </button>

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="默认模型"
          ref={listRef}
          data-testid="assistant-model-picker"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(1);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(-1);
              return;
            }
            if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const options = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
              (event.key === 'Home' ? options[0] : options[options.length - 1])?.focus();
              return;
            }
            if (event.key === 'Escape') {
              // 只关这一层：浮层不是模态，不能让 Escape 穿透去关别的东西。
              event.preventDefault();
              event.stopPropagation();
              close(true);
              return;
            }
            if (event.key === 'Tab') {
              setOpen(false);
            }
          }}
          className="absolute bottom-[calc(100%+6px)] left-0 z-30 flex max-h-[320px] w-[min(320px,calc(100vw-24px))] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow-popover)]"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
            <span className="text-subtle text-[var(--font-micro-size)]">默认模型</span>
            <button
              type="button"
              onClick={() => {
                close(false);
                onOpenSettings();
              }}
              data-testid="assistant-model-picker-manage"
              className="ml-auto flex items-center gap-1 rounded-control px-1.5 py-0.5 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              <Settings2 size={10} aria-hidden="true" />
              管理模型
            </button>
          </div>

          {providerGroups.length === 0 ? (
            <p className="px-2 py-3 text-subtle text-[var(--font-micro-size)]">
              还没有可选的模型，先在上面的端点下添加模型。
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
              {providerGroups.map((group) => (
                <div key={group.providerId} role="group" aria-label={group.providerLabel} className="flex flex-col">
                  <span className="px-2 pt-1 pb-0.5 text-subtle text-[var(--font-micro-size)]">{group.providerLabel}</span>
                  {group.items.map((choice) => {
                    const selected = choice.key === currentKey;
                    return (
                      <button
                        key={choice.key}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        disabled={!choice.enabled}
                        onClick={() => {
                          if (selected) {
                            close(true);
                            return;
                          }
                          // 选中**不**立即关浮层：写后端需要一次往返，失败原因要留在
                          // 发起写入的地方（关掉浮层再弹错误，等于让用户重新打开才知道
                          // 为什么没换成）。写完成后由下面的 effect 决定关还是不关。
                          setSubmitted(true);
                          onSelect(choice.key);
                        }}
                        data-testid={`assistant-model-picker-option-${choice.key}`}
                        className={
                          selected
                            ? 'flex items-center gap-2 bg-accent-soft px-2 py-1 text-left text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent'
                            : 'flex items-center gap-2 px-2 py-1 text-left text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent disabled:opacity-40'
                        }
                      >
                        <span className="min-w-0 flex-1 truncate text-[var(--font-meta-size)]">{choice.label}</span>
                        {choice.enabled ? null : (
                          <span className="shrink-0 text-subtle text-[var(--font-micro-size)]">已停用</span>
                        )}
                        {selected ? <Check size={11} aria-hidden="true" className="shrink-0 text-accent" /> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {error === null ? null : (
            <p
              role="alert"
              data-testid="assistant-model-picker-error"
              className="shrink-0 border-t border-line px-2 py-1 text-[var(--st-bad)] text-[var(--font-micro-size)]"
            >
              {error}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
