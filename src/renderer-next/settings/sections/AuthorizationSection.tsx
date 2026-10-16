import { useEffect, useMemo, useState } from 'react';
import { PlugZap } from 'lucide-react';
import type { McpServerSnapshot, McpServerTestResult } from '../../../shared/types';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import type { SettingsStore } from '../settings-scope';
import { getMcpConfig, listMcpServers, setMcpApprovalMode, setMcpServerEnabled, testMcpServer } from '../settings-store';
import {
  CheckboxField,
  SettingsNote,
  SettingsSection,
  settingsInputClass,
  settingsSecondaryButtonClass
} from '../settings-ui';

/**
 * 授权与安全 (T8.3).
 *
 * The MCP authorization surface: the approval mode the kernel enforces and the list of
 * authorised servers with their connection state. Server *authoring* (add/edit/delete) is
 * the P9 management panel's job — this section owns the two decisions that belong to
 * settings: which mode approvals run in, and whether an already-configured server is on.
 *
 * `mcp.getConfig` and `mcp.listServers` disagree by design: the config carries the
 * authoring fields (`riskLevel`, `allowedTools`, `command`), the snapshot carries runtime
 * state (`status`, `tools`, `lastError`). The rows are merged by id so neither is presented
 * as the whole truth.
 */

export function AuthorizationSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const config = useAsyncResource('settings:mcp-config', () => getMcpConfig(store.client), {
    label: '读取 MCP 配置'
  });
  const servers = useAsyncResource('settings:mcp-servers', () => listMcpServers(store.client), {
    label: '读取 MCP 服务'
  });
  const [testResults, setTestResults] = useState<Record<string, McpServerTestResult>>({});

  const approvalMode = useAsyncAction(
    (mode: 'fully_automatic' | 'default') => setMcpApprovalMode(store.client, mode),
    { label: '设置 MCP 审批模式' }
  );
  const setEnabled = useAsyncAction(
    (input: { id: string; enabled: boolean }) => setMcpServerEnabled(store.client, input),
    { label: '切换 MCP 服务' }
  );
  const test = useAsyncAction((id: string) => testMcpServer(store.client, id), { label: '测试 MCP 服务' });

  const reloadServers = servers.reload;
  const reloadConfig = config.reload;
  const snapshots = servers.data ?? [];
  const configServers = config.data?.servers ?? [];

  const merged = useMemo(
    () =>
      snapshots.map((snapshot: McpServerSnapshot) => ({
        snapshot,
        authored: configServers.find((entry) => entry.id === snapshot.id) ?? null
      })),
    [snapshots, configServers]
  );

  // A test result belongs to one server row; clear it when the list itself is reloaded so a
  // stale "ready" cannot outlive the state it described.
  useEffect(() => {
    setTestResults({});
  }, [servers.data]);

  return (
    <SettingsSection
      title="授权与安全"
      hint="mcp.getConfig / setApprovalMode · mcp.listServers / setServerEnabled / testServer"
      testId="settings-section-authorization-body"
    >
      {config.error === null ? null : (
        <SettingsNote tone="warn" testId="settings-mcp-config-error">
          {config.error}
        </SettingsNote>
      )}
      <label className="flex max-w-[420px] flex-col gap-0.5">
        <span className="text-subtle text-[var(--font-micro-size)]">MCP 审批模式（mcp.approvalMode）</span>
        <select
          value={config.data?.approvalMode ?? 'default'}
          disabled={config.data === null || approvalMode.pending}
          onChange={(event) => {
            const next = event.target.value === 'fully_automatic' ? 'fully_automatic' : 'default';
            void approvalMode.run(next).then((result) => {
              if (result !== null) {
                reloadConfig();
                reloadServers();
              }
            });
          }}
          data-testid="settings-mcp-approval-mode"
          className={settingsInputClass}
        >
          <option value="default">默认：MCP 工具调用需要审批</option>
          <option value="fully_automatic">全自动：MCP 工具调用不拦截</option>
        </select>
      </label>
      {approvalMode.error === null ? null : (
        <SettingsNote tone="warn" testId="settings-mcp-approval-error">
          {approvalMode.error}
        </SettingsNote>
      )}

      {servers.error === null ? null : (
        <SettingsNote tone="warn" testId="settings-mcp-servers-error">
          {servers.error}
        </SettingsNote>
      )}

      {merged.length === 0 ? (
        <SettingsNote testId="settings-mcp-empty">
          后端还没有已授权的 MCP 服务（P9 的管理面板负责新增与编辑；这里只列出并开关已有的）。
        </SettingsNote>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="settings-mcp-list">
          {merged.map(({ snapshot, authored }) => (
            <li
              key={snapshot.id}
              className="flex flex-col gap-1 rounded-card border border-line bg-surface px-3 py-2"
              data-testid={`settings-mcp-${snapshot.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ink text-[var(--font-meta-size)]">{snapshot.name}</span>
                <span className="font-mono text-subtle text-[var(--font-micro-size)]">{snapshot.id}</span>
                <span className="text-subtle text-[var(--font-micro-size)]">
                  {snapshot.transport} · {snapshot.tools} 个工具 ·{' '}
                  {snapshot.status === 'ready' ? '已连接' : snapshot.status === 'error' ? '连接错误' : '未连接'}
                </span>
                {authored?.riskLevel === undefined ? null : (
                  <span className="text-subtle text-[var(--font-micro-size)]">风险：{authored.riskLevel}</span>
                )}
                {snapshot.preset === true || authored?.preset === true ? (
                  <span className="rounded-control border border-line px-1.5 text-subtle text-[var(--font-micro-size)]">
                    预置
                  </span>
                ) : null}
              </div>
              {snapshot.lastError === null || snapshot.lastError === undefined ? null : (
                <SettingsNote tone="warn" testId={`settings-mcp-error-${snapshot.id}`}>
                  {snapshot.lastError}
                </SettingsNote>
              )}
              {authored === null || authored.allowedTools.length === 0 ? null : (
                <p className="text-subtle text-[var(--font-micro-size)]">
                  允许的工具：{authored.allowedTools.join(', ')}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <CheckboxField
                  label="启用"
                  checked={snapshot.enabled}
                  onChange={(enabled) => {
                    void setEnabled.run({ id: snapshot.id, enabled }).then((result) => {
                      if (result !== null) {
                        reloadServers();
                        reloadConfig();
                      }
                    });
                  }}
                  testId={`settings-mcp-enabled-${snapshot.id}`}
                />
                <button
                  type="button"
                  data-testid={`settings-mcp-test-${snapshot.id}`}
                  disabled={test.pending}
                  onClick={() => {
                    void test.run(snapshot.id).then((result) => {
                      if (result !== null) {
                        setTestResults((current) => ({ ...current, [snapshot.id]: result }));
                        reloadServers();
                      }
                    });
                  }}
                  className={`${settingsSecondaryButtonClass} inline-flex items-center gap-1`}
                >
                  <PlugZap size={11} aria-hidden="true" />
                  测试连接
                </button>
                {testResults[snapshot.id] === undefined ? null : (
                  <span className="text-[var(--font-micro-size)] text-muted" data-testid={`settings-mcp-test-result-${snapshot.id}`}>
                    {testResults[snapshot.id]?.status === 'ready'
                      ? '连接成功'
                      : `连接失败：${testResults[snapshot.id]?.error ?? '后端没有给出原因'}`}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {setEnabled.error === null ? null : (
        <SettingsNote tone="warn" testId="settings-mcp-enable-error">
          {setEnabled.error}
        </SettingsNote>
      )}
      {test.error === null ? null : (
        <SettingsNote tone="warn" testId="settings-mcp-test-error">
          {test.error}
        </SettingsNote>
      )}

      <SettingsNote testId="settings-authorization-note">
        MCP 服务的增删改（`mcp.upsertServer` / `deleteServer` / `ensureExaPreset`）在管理面板的授权分区（P9）；
        这里管的是审批模式与已授权服务的开关。MCP 的审批模式与「智能体安全」里的工具审批模式是两套（后者管内置工具）。
      </SettingsNote>
    </SettingsSection>
  );
}
