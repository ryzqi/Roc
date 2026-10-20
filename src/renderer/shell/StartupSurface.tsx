/**
 * Startup surfaces.
 *
 * The window shows exactly one of these until the shell can mount, and the same
 * component renders the "preload bridge missing" case from `App.tsx` and the
 * "app.getStatus failed" case from `AppShell.tsx`, so the boot-failure contract
 * cannot drift between the two entry paths.
 *
 * The `.boot` / `.fatal` classes and `data-testid` values keep the legacy smoke
 * convention (`tests/smoke/lib/assertions.mjs` waits on
 * `[data-testid="roc-app"], .fatal, .boot` and then counts `.fatal`). P1 keeps
 * the convention so the harness can be repointed rather than rewritten; P10
 * owns the final naming pass.
 */

export function StartupLoading(): React.JSX.Element {
  return (
    <div
      className="boot flex h-full w-full items-center justify-center bg-bg text-muted"
      data-testid="roc-app-startup"
      role="status"
    >
      Roc 正在加载本地工作台
    </div>
  );
}

export function StartupFailure({
  title = 'Roc 启动失败',
  message
}: {
  title?: string;
  message: string;
}): React.JSX.Element {
  return (
    <div
      className="fatal flex h-full w-full items-center justify-center bg-bg px-8"
      data-testid="roc-app-startup-error"
      role="alert"
    >
      <div className="max-w-md rounded-card border border-line bg-surface px-5 py-4">
        <p className="text-ink">{title}</p>
        <p className="mt-1 break-words text-muted">{message}</p>
        <p className="mt-2 text-[var(--font-micro-size)] text-subtle">
          可运行「运行诊断」查看主机检查；若持续失败，请重启 Roc。
        </p>
      </div>
    </div>
  );
}
