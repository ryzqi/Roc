import { PlugZap } from 'lucide-react';
import type { SettingsStore } from '../settings-scope';
import { useMcp } from '../../management/use-mcp';
import { CheckboxField, FormNote, FormSection, formInputClass, formSecondaryButtonClass } from '../../shared/form-ui';

/** Authorization consumes the same configuration-owned rows and mutations as management. */
export function AuthorizationSection({ store }: { store: SettingsStore }): React.JSX.Element {
  // This narrower surface does not show capability previews or need their IPC reads.
  const mcp = useMcp(store.client, null);
  return (
    <FormSection title="授权与安全" testId="settings-section-authorization-body">
      {mcp.error === null ? null : (
        <FormNote tone="warn" testId="settings-mcp-config-error">{mcp.error}</FormNote>
      )}
      <label className="flex max-w-[420px] flex-col gap-0.5">
        <span className="text-subtle text-[var(--font-micro-size)]">MCP 审批模式</span>
        <select
          value={mcp.config?.approvalMode ?? 'default'}
          disabled={mcp.config === null || mcp.approvalMode.pending}
          onChange={(event) => {
            void mcp.approvalMode.run(event.target.value === 'fully_automatic' ? 'fully_automatic' : 'default');
          }}
          data-testid="settings-mcp-approval-mode"
          className={formInputClass}
        >
          <option value="default">默认：MCP 工具调用需要审批</option>
          <option value="fully_automatic">全自动：MCP 工具调用不拦截</option>
        </select>
      </label>
      {mcp.approvalMode.error === null ? null : (
        <FormNote tone="warn" testId="settings-mcp-approval-error">{mcp.approvalMode.error}</FormNote>
      )}
      {mcp.runtimeError === null ? null : (
        <FormNote tone="warn" testId="settings-mcp-servers-error">{mcp.runtimeError}</FormNote>
      )}
      <ul className="flex flex-col gap-2" data-testid="settings-mcp-list">
        {mcp.rows.map(({ server, snapshot, enabled, issue }) => (
          <li key={server.id} className="flex flex-col gap-1 rounded-card border border-line bg-surface px-3 py-2" data-testid={`settings-mcp-${server.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink text-[var(--font-meta-size)]">{server.name}</span>
              <span className="font-mono text-subtle text-[var(--font-micro-size)]">{server.id}</span>
              <span className="text-subtle text-[var(--font-micro-size)]">
                {server.transport} · {snapshot?.tools ?? 0} 个工具 ·{' '}
                {snapshot === null ? '运行状态不可用' : snapshot.status === 'ready' ? '已连接' : snapshot.status === 'error' ? '连接错误' : '未连接'}
              </span>
              {server.riskLevel === undefined ? null : <span className="text-subtle text-[var(--font-micro-size)]">风险：{server.riskLevel}</span>}
              {server.preset !== true ? null : <span className="rounded-control border border-line px-1.5 text-subtle text-[var(--font-micro-size)]">预置</span>}
            </div>
            {issue === null ? null : <FormNote tone="warn" testId={`settings-mcp-error-${server.id}`}>{issue}</FormNote>}
            {server.allowedTools.length === 0 ? null : (
              <p className="text-subtle text-[var(--font-micro-size)]">允许的工具：{server.allowedTools.join(', ')}</p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <CheckboxField label="启用" checked={enabled}
                disabled={mcp.toggle.pending || mcp.status === 'loading'}
                onChange={(next) => { void mcp.toggle.run(server.id, next); }}
                testId={`settings-mcp-enabled-${server.id}`} />
              <button type="button" data-testid={`settings-mcp-test-${server.id}`} disabled={mcp.test.pending}
                onClick={() => { void mcp.test.run(server.id); }}
                className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}>
                <PlugZap size={11} aria-hidden="true" />校验配置
              </button>
              {mcp.test.results[server.id] === undefined ? null : (
                <span className="text-[var(--font-micro-size)] text-muted" data-testid={`settings-mcp-test-result-${server.id}`}>
                  {mcp.test.results[server.id]?.status === 'ready' ? '配置完整' : `配置有问题：${mcp.test.results[server.id]?.error ?? '未知原因'}`}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {mcp.toggle.error === null ? null : <FormNote tone="warn" testId="settings-mcp-enable-error">{mcp.toggle.error}</FormNote>}
      {mcp.test.error === null ? null : <FormNote tone="warn" testId="settings-mcp-test-error">{mcp.test.error}</FormNote>}
    </FormSection>
  );
}
