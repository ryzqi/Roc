/**
 * Startup surfaces (MASTER v2 §10).
 *
 * The window shows exactly one of these until the shell can mount, and the same
 * component renders the "preload bridge missing" case from `App.tsx` and the
 * "app.getStatus failed" case from `AppShell.tsx`. Keeping one component means
 * the boot-failure contract cannot drift between the two entry paths.
 */

export function StartupLoading(): React.JSX.Element {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-bg text-muted"
      data-testid="roc-app-startup"
      role="status"
    >
      Roc 正在加载本地工作台
    </div>
  );
}

export function StartupFailure({ title = 'Roc 启动失败', message }: { title?: string; message: string }): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg px-8" data-testid="roc-app-startup-error">
      <div role="alert" className="max-w-md rounded-card border border-line bg-surface px-5 py-4">
        <p className="text-ink">{title}</p>
        <p className="mt-1 text-muted break-words">{message}</p>
        <p className="mt-2 text-subtle text-[var(--font-micro-size)]">
          可运行「运行诊断」查看主机检查；若持续失败，请重启 Roc。
        </p>
      </div>
    </div>
  );
}
