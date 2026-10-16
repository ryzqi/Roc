import { useState } from 'react';
import { PlugZap, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import type { McpServerConfig } from '../../../shared/types';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import { FormNote, FormSection, KeyValueRow, formInputClass, formSecondaryButtonClass, formTextAreaClass } from '../../shared/form-ui';
import type { ManagementScope } from '../management-scope';
import {
  builtInTools,
  issueFor,
  manifestToolsForServer,
  mcpApprovalModeLabels,
  mcpRiskLabels,
  mcpStatusLabels,
  mcpTransportLabels,
  previewSummary,
  skippedCapabilities
} from '../mcp-model';
import type { McpStore } from '../use-mcp';

/**
 * MCP (P9/T9.3).
 *
 * ## What is authorable, and what is only reported
 *
 * `mcpServerConfigSchema` is `{id, name, enabled, transport, preset, riskLevel, url?, command?,
 * allowedTools[]}` — a stdio server is **one command string** and an http/sse server is **one
 * url**. There is no args/env/headers, so the form has the fields the backend has (F24).
 *
 * ## Tool names come from the assembly preview
 *
 * `mcp.listServers` returns `tools: allowedTools.length` (a count of allowed *names*) and a
 * `status` that stays `not_connected` until a test runs; `mcp.tools.get` exists in the plugin but
 * has **no IPC channel** (B25). The per-server tool list is therefore read from
 * `agent.getCapabilityPreview`, whose manifest carries `{kind:'mcp', serverId}` — the same list
 * the next run would use. `mcp.testServer` returns `{status, checked[], error}` and **no latency**,
 * so the row reports the error text and the checked items instead of inventing a number.
 *
 * ## The approval mode is a jump, not a second switch
 *
 * P8 owns the single writer for the global MCP approval mode (设置 → 授权与安全); this panel shows
 * the current value and links there. Two live controls for one value would drift the moment both
 * are open, and there is no way to reconcile them.
 */

/** `name[需审批]` — the one fact the preview adds per tool. */
function toolLabel(tool: { name: string; approval: string }): string {
  return `${tool.name}[${tool.approval === 'required' ? '需审批' : '免审批'}]`;
}

export function McpSection({
  scope,
  store: mcp
}: {
  scope: ManagementScope;
  /**
   * The skills store is not read here — the shell passes the enabled ids into `useMcp` so the
   * assembly preview names the same skills the assistant would use.
   */
  store: McpStore;
}): React.JSX.Element {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const deleteRecord = mcp.rows.find((row) => row.server.id === deleteTarget)?.server ?? null;
  const enabledCount = mcp.rows.filter((row) => row.server.enabled).length;
  const selectedTools = mcp.draft === null ? [] : manifestToolsForServer(mcp.preview, mcp.draft.id.trim());

  const startEditFromRow = (server: McpServerConfig): void => {
    mcp.startEdit(server);
  };

  // A refresh (`status: 'loading'`) must not blank the panel: the previous config is still the best
  // thing to show, and swapping it for a note would detach every control (the P9 gate caught the
  // reload button disappearing mid-click).
  if (mcp.config === null) {
    return mcp.status === 'error' ? (
      <FormNote tone="warn" testId="mgmt-mcp-error">
        读取 MCP 配置失败：{mcp.error}
      </FormNote>
    ) : (
      <FormNote testId="mgmt-mcp-loading">正在读取 MCP 配置…</FormNote>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="mgmt-mcp">
      <FormSection
        title="已授权服务"
        hint="mcp.getConfig + mcp.listServers（配置与运行时快照按 id 合并）"
        testId="mgmt-mcp-servers"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted text-[var(--font-meta-size)]" data-testid="mgmt-mcp-summary">
            {mcp.rows.length} 个服务 · {enabledCount} 个已启用 · 装配预览里 MCP 工具 {mcp.preview?.toolCards.length ?? 0} 个
          </span>
          <button
            type="button"
            data-testid="mgmt-mcp-reload"
            disabled={mcp.status === 'loading'}
            onClick={() => mcp.reload()}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <RefreshCw size={11} aria-hidden="true" />
            重新读取
          </button>
          <button
            type="button"
            data-testid="mgmt-mcp-create"
            onClick={() => mcp.startCreate()}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Plus size={11} aria-hidden="true" />
            新建服务
          </button>
          <button
            type="button"
            data-testid="mgmt-mcp-preset"
            disabled={mcp.preset.pending}
            onClick={() => {
              void mcp.preset.run();
            }}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Sparkles size={11} aria-hidden="true" />
            预置 Exa（mcp.ensureExaPreset）
          </button>
        </div>

        {/* toggle / test / delete / preset / save all report through one state, so one note covers
            them — and it must be outside the editor block or a failed toggle would say nothing. */}
        {mcp.save.error === null ? null : (
          <FormNote tone="warn" testId="mgmt-mcp-mutation-error">
            操作失败：{mcp.save.error}
          </FormNote>
        )}

        <dl className="flex flex-col gap-0.5">
          <KeyValueRow
            label="审批模式"
            value={mcpApprovalModeLabels[mcp.config.approvalMode]}
            testId="mgmt-mcp-approval-mode"
          />
        </dl>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="mgmt-mcp-open-settings"
            onClick={() => scope.openSettings()}
            className={formSecondaryButtonClass}
          >
            在设置中心修改审批模式
          </button>
          <span className="text-subtle text-[var(--font-micro-size)]">
            审批模式是全局策略，唯一写入口在设置中心（P8），这里只显示当前值。
          </span>
        </div>

        {mcp.rows.length === 0 ? (
          <FormNote testId="mgmt-mcp-empty">
            还没有已授权的 MCP 服务。用「新建服务」或「预置 Exa」添加一个，然后校验配置；真正的连接发生在运行开始时（见下方说明）。
          </FormNote>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="mgmt-mcp-rows">
            {mcp.rows.map(({ server, snapshot }) => {
              const tools = manifestToolsForServer(mcp.preview, server.id);
              const result = mcp.test.results[server.id] ?? null;
              return (
                <li
                  key={server.id}
                  className="flex flex-col gap-1 rounded-card border border-line px-2 py-1.5"
                  data-testid={`mgmt-mcp-server-${server.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ink text-[var(--font-meta-size)]">{server.name}</span>
                    <span className="font-mono text-subtle text-[var(--font-micro-size)]">{server.id}</span>
                    <span className="text-subtle text-[var(--font-micro-size)]">{mcpTransportLabels[server.transport]}</span>
                    <span className="text-subtle text-[var(--font-micro-size)]">风险 {mcpRiskLabels[server.riskLevel]}</span>
                    {server.preset ? (
                      <span className="rounded-control border border-line px-1.5 text-subtle text-[var(--font-micro-size)]">
                        预置
                      </span>
                    ) : null}
                    <span className="text-subtle text-[var(--font-micro-size)]" data-testid={`mgmt-mcp-status-${server.id}`}>
                      {snapshot === null ? '未在运行时列表里' : mcpStatusLabels[snapshot.status]}
                    </span>
                  </div>
                  <span className="break-all font-mono text-muted text-[var(--font-micro-size)]">
                    {server.transport === 'stdio' ? (server.command ?? '（缺少 command）') : (server.url ?? '（缺少 url）')}
                  </span>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1 text-[var(--font-micro-size)] text-muted">
                      <input
                        type="checkbox"
                        checked={mcp.serverEnabled(server)}
                        disabled={mcp.toggle.pending}
                        onChange={(event) => {
                          void mcp.toggle.run(server.id, event.target.checked);
                        }}
                        data-testid={`mgmt-mcp-enabled-${server.id}`}
                        className="h-3.5 w-3.5 rounded-[3px] border border-line accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      />
                      启用
                    </label>
                    <button
                      type="button"
                      data-testid={`mgmt-mcp-test-${server.id}`}
                      disabled={mcp.test.pending}
                      onClick={() => {
                        void mcp.test.run(server.id);
                      }}
                      className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
                    >
                      <PlugZap size={11} aria-hidden="true" />
                      校验配置
                    </button>
                    <button
                      type="button"
                      data-testid={`mgmt-mcp-edit-${server.id}`}
                      onClick={() => startEditFromRow(server)}
                      className={formSecondaryButtonClass}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      data-testid={`mgmt-mcp-delete-${server.id}`}
                      disabled={mcp.remove.pending}
                      onClick={() => setDeleteTarget(server.id)}
                      className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
                    >
                      <Trash2 size={11} aria-hidden="true" />
                      删除
                    </button>
                    {snapshot?.lastError === null || snapshot?.lastError === undefined ? null : (
                      <FormNote tone="warn" testId={`mgmt-mcp-last-error-${server.id}`}>
                        {snapshot.lastError}
                      </FormNote>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-subtle text-[var(--font-micro-size)]">
                      允许的工具（{server.allowedTools.length} 个名字，配置项）：{server.allowedTools.join(', ') || '（空）'}
                    </span>
                    <span className="text-subtle text-[var(--font-micro-size)]" data-testid={`mgmt-mcp-tools-${server.id}`}>
                      装配预览里的工具（{tools.length} 个，下一次运行会用它）：
                      {tools.length === 0 ? '（未启用或未解析）' : tools.map(toolLabel).join(', ')}
                    </span>
                  </div>
                  {result === null ? null : (
                    <FormNote
                      tone={result.status === 'ready' ? 'default' : 'warn'}
                      testId={`mgmt-mcp-test-result-${server.id}`}
                    >
                      {result.status === 'ready'
                        ? '配置完整（后端只校验配置字段，不连接）'
                        : `配置有问题：${result.error ?? '后端没有给出原因'}`}{' '}
                      · 检查项 {result.checked.join('、')}
                    </FormNote>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <FormNote testId="mgmt-mcp-contract-note">
          契约上没有 args / env / headers，也没有逐服务的审批模式与延迟字段：stdio 只有一个启动命令、审批模式是全局的，
          「校验配置」只检查字段是否齐全（不 spawn、不发请求），因此没有延迟可显示。真正的连接发生在运行开始时（run 路径调
          `mcp.tools.get`），工具名以装配预览为准（F24 ③）。
        </FormNote>
      </FormSection>

      {mcp.draft === null ? null : (
        <FormSection
          title={mcp.editingId === null ? '新建 MCP 服务' : `编辑 ${mcp.editingId}`}
          hint="mcp.upsertServer（整份 server 配置，按 id 覆盖）"
          testId="mgmt-mcp-editor"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[var(--font-micro-size)]">id</span>
              <input
                value={mcp.draft.id}
                disabled={mcp.editingId !== null}
                onChange={(event) => mcp.setDraft({ ...mcp.draft!, id: event.target.value })}
                data-testid="mgmt-mcp-draft-id"
                className={formInputClass}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[var(--font-micro-size)]">名称</span>
              <input
                value={mcp.draft.name}
                onChange={(event) => mcp.setDraft({ ...mcp.draft!, name: event.target.value })}
                data-testid="mgmt-mcp-draft-name"
                className={formInputClass}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[var(--font-micro-size)]">传输</span>
              <select
                value={mcp.draft.transport}
                onChange={(event) =>
                  mcp.setDraft({ ...mcp.draft!, transport: event.target.value as McpServerConfig['transport'] })
                }
                data-testid="mgmt-mcp-draft-transport"
                className={formInputClass}
              >
                <option value="stdio">stdio（本地命令）</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-subtle text-[var(--font-micro-size)]">风险等级</span>
              <select
                value={mcp.draft.riskLevel}
                onChange={(event) =>
                  mcp.setDraft({ ...mcp.draft!, riskLevel: event.target.value as McpServerConfig['riskLevel'] })
                }
                data-testid="mgmt-mcp-draft-risk"
                className={formInputClass}
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
            {mcp.draft.transport === 'stdio' ? (
              <label className="flex flex-col gap-0.5 sm:col-span-2">
                <span className="text-subtle text-[var(--font-micro-size)]">启动命令（单个字符串）</span>
                <input
                  value={mcp.draft.command}
                  onChange={(event) => mcp.setDraft({ ...mcp.draft!, command: event.target.value })}
                  placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp"
                  data-testid="mgmt-mcp-draft-command"
                  className={formInputClass}
                />
              </label>
            ) : (
              <label className="flex flex-col gap-0.5 sm:col-span-2">
                <span className="text-subtle text-[var(--font-micro-size)]">URL</span>
                <input
                  value={mcp.draft.url}
                  onChange={(event) => mcp.setDraft({ ...mcp.draft!, url: event.target.value })}
                  placeholder="https://mcp.example.test/mcp"
                  data-testid="mgmt-mcp-draft-url"
                  className={formInputClass}
                />
              </label>
            )}
          </div>
          <label className="flex flex-col gap-0.5">
            <span className="text-subtle text-[var(--font-micro-size)]">允许的工具（每行一个名字；空表示不预先限制）</span>
            <textarea
              value={mcp.draft.allowedToolsText}
              rows={4}
              onChange={(event) => mcp.setDraft({ ...mcp.draft!, allowedToolsText: event.target.value })}
              data-testid="mgmt-mcp-draft-tools"
              className={formTextAreaClass}
            />
          </label>
          <label className="flex items-center gap-1 text-[var(--font-micro-size)] text-muted">
            <input
              type="checkbox"
              checked={mcp.draft.enabled}
              onChange={(event) => mcp.setDraft({ ...mcp.draft!, enabled: event.target.checked })}
              data-testid="mgmt-mcp-draft-enabled"
              className="h-3.5 w-3.5 rounded-[3px] border border-line accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            />
            启用该服务
          </label>
          {(['id', 'name', 'url', 'command', 'allowedToolsText'] as const).map((field) => {
            const issue = issueFor(mcp.issues, field);
            return issue === null ? null : (
              <FormNote key={field} tone="warn" testId={`mgmt-mcp-issue-${field}`}>
                {issue}
              </FormNote>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="mgmt-mcp-save"
              disabled={mcp.save.pending || mcp.issues.length > 0}
              onClick={() => {
                void mcp.save.run();
              }}
              className={formSecondaryButtonClass}
            >
              {mcp.save.pending ? '保存中…' : '保存服务'}
            </button>
            <button
              type="button"
              data-testid="mgmt-mcp-cancel"
              onClick={() => mcp.cancelEdit()}
              className={formSecondaryButtonClass}
            >
              取消
            </button>
            {selectedTools.length === 0 ? null : (
              <span className="text-subtle text-[var(--font-micro-size)]">
                当前 id 在装配预览里有 {selectedTools.length} 个工具
              </span>
            )}
          </div>
          {mcp.save.error === null ? null : (
            <FormNote tone="warn" testId="mgmt-mcp-save-error">
              {mcp.save.error}
            </FormNote>
          )}
        </FormSection>
      )}

      <FormSection
        title="助手的工具装配预览"
        hint="agent.capability.preview（唯一能拿到逐服务工具名的地方）"
        testId="mgmt-mcp-preview"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted text-[var(--font-meta-size)]" data-testid="mgmt-mcp-preview-summary">
            {previewSummary(mcp.preview)}
          </span>
          <button
            type="button"
            data-testid="mgmt-mcp-preview-reload"
            disabled={mcp.previewStatus === 'loading'}
            onClick={() => mcp.reloadPreview()}
            className={formSecondaryButtonClass}
          >
            重新装配
          </button>
        </div>
        {mcp.previewError === null ? null : (
          <FormNote tone="warn" testId="mgmt-mcp-preview-error">
            {mcp.previewError}
          </FormNote>
        )}
        {mcp.preview === null ? null : (
          <>
            <dl className="flex flex-col gap-0.5">
              <KeyValueRow label="内置工具" value={builtInTools(mcp.preview).join(', ') || '（无）'} testId="mgmt-mcp-preview-builtin" />
              <KeyValueRow
                label="技能"
                value={
                  mcp.preview.skillCards.length === 0
                    ? '（没有启用的技能）'
                    : mcp.preview.skillCards.map((card) => card.name).join(', ')
                }
                testId="mgmt-mcp-preview-skills"
              />
            </dl>
            {skippedCapabilities(mcp.preview).length === 0 ? null : (
              <ul className="flex flex-col gap-0.5" data-testid="mgmt-mcp-preview-skipped">
                {skippedCapabilities(mcp.preview).map((entry) => (
                  <li key={`${entry.type}:${entry.id}`} className="text-[var(--st-warn)] text-[var(--font-micro-size)]">
                    未解析：{entry.type} {entry.id}（{entry.reason}）
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <FormNote testId="mgmt-mcp-preview-note">
          这是「下一次运行会装配什么」的只读预览：`manifest.tools[].provenance` 带 serverId，所以逐服务的工具名只有
          这里拿得到（`mcp.tools.get` 没有 IPC 通道，B25）。启用的服务与技能一变，预览就按新的 id 集合重读。
        </FormNote>
      </FormSection>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个 MCP 服务？"
        message={`将从 MCP 配置里删除 ${deleteRecord?.name ?? deleteTarget ?? ''}。`}
        detail="删除后助手不能再调用它的工具；服务端的任何东西不受影响。"
        confirmLabel="删除"
        tone="destructive"
        testId="mgmt-mcp-delete-confirm"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target !== null) {
            void mcp.remove.run(target);
          }
        }}
      />
    </div>
  );
}
