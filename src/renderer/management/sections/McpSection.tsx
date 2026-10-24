import { useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sparkles
} from 'lucide-react';
import type { McpServerConfig } from '../../../shared/types';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import {
  FormNote,
  FormSection,
  KeyValueRow,
  formInputClass,
  formPrimaryButtonClass,
  formSecondaryButtonClass
} from '../../shared/form-ui';
import type { ManagementScope } from '../management-scope';
import {
  builtInTools,
  draftFromServer,
  manifestToolsForServer,
  mcpApprovalModeLabels,
  mcpRiskLabels,
  mcpTransportLabels,
  previewSummary,
  skippedCapabilities,
  validateMcpDraft
} from '../mcp-model';
import type { McpStore } from '../use-mcp';
import { McpEditor } from './McpEditor';

const actionClass = `${formSecondaryButtonClass} inline-flex shrink-0 items-center justify-center gap-1.5`;
const menuActionClass =
  'block w-full rounded-control px-3 py-2 text-left text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent';
type Filter = 'all' | 'enabled' | 'disabled' | 'issues';

/** Configuration checks are not connection checks. Tool names come only from the run preview. */
export function McpSection({
  scope,
  store: mcp
}: {
  scope: ManagementScope;
  store: McpStore;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const listScroll = useRef(0);
  const returnFocus = useRef<string | null>(null);
  const selected = mcp.rows.find(({ server }) => server.id === selectedId);
  const deleteRecord = mcp.rows.find(
    ({ server }) => server.id === deleteTarget
  )?.server;
  const page =
    mcp.draft !== null
      ? 'editor'
      : adding
        ? 'add'
        : selected !== undefined
          ? 'detail'
          : 'list';

  useLayoutEffect(() => {
    const panel = root.current?.closest('[role="tabpanel"]');
    if (panel) panel.scrollTop = page === 'list' ? listScroll.current : 0;
    if (page === 'list' && returnFocus.current !== null) {
      const buttons =
        root.current?.querySelectorAll<HTMLButtonElement>('[data-server-id]');
      const target = Array.from(buttons ?? []).find(
        (button) => button.dataset.serverId === returnFocus.current
      );
      target?.focus({ preventScroll: true });
    } else {
      if (heading.current) heading.current.focus({ preventScroll: true });
      else
        root.current
          ?.querySelector<HTMLInputElement>(
            '[data-testid="mgmt-mcp-editor"] input'
          )
          ?.focus({ preventScroll: true });
    }
  }, [page]);

  const rememberList = (id: string | null): void => {
    listScroll.current =
      root.current?.closest('[role="tabpanel"]')?.scrollTop ?? 0;
    returnFocus.current = id;
  };
  const back = (): void => {
    mcp.cancelEdit();
    setAdding(false);
    setSelectedId(null);
  };
  const issueForServer = (server: McpServerConfig): string | null => {
    const configIssue = validateMcpDraft(draftFromServer(server))[0]?.message;
    if (configIssue) return configIssue;
    const result = mcp.test.results[server.id];
    if (result?.status === 'invalid') return result.error ?? '配置有问题';
    const snapshot = mcp.rows.find(
      (row) => row.server.id === server.id
    )?.snapshot;
    if (snapshot?.lastError) return snapshot.lastError;
    if (snapshot?.status === 'error') return '连接错误';
    const skipped =
      mcp.previewStatus === 'ready' && mcp.serverEnabled(server)
        ? skippedCapabilities(mcp.preview).find(
            (entry) => entry.type === 'MCP 服务' && entry.id === server.id
          )
        : undefined;
    return skipped ? `工具预览未包含此服务：${skipped.reason}` : null;
  };
  const toolSummary = (server: McpServerConfig): string => {
    if (!mcp.serverEnabled(server)) return '已停用';
    if (mcp.previewStatus === 'loading' || mcp.toggle.pending)
      return '正在更新工具预览…';
    if (mcp.previewStatus === 'error' || mcp.preview === null)
      return '工具预览不可用';
    return `下次对话提供 ${manifestToolsForServer(mcp.preview, server.id).length} 个工具`;
  };
  const enabledCount = mcp.rows.filter(({ server }) =>
    mcp.serverEnabled(server)
  ).length;
  const issueCount = mcp.rows.filter(
    ({ server }) => issueForServer(server) !== null
  ).length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRows = mcp.rows.filter(({ server }) => {
    const enabled = mcp.serverEnabled(server);
    return (
      (!normalizedQuery ||
        `${server.name} ${server.id}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)) &&
      (filter === 'all' ||
        (filter === 'enabled' && enabled) ||
        (filter === 'disabled' && !enabled) ||
        (filter === 'issues' && issueForServer(server) !== null))
    );
  });

  const toggle = (server: McpServerConfig): React.JSX.Element => (
    <button
      type="button"
      role="switch"
      aria-checked={mcp.serverEnabled(server)}
      aria-label={`启用 ${server.name}`}
      disabled={mcp.toggle.pending || mcp.status === 'loading'}
      onClick={() => {
        void mcp.toggle.run(server.id, !mcp.serverEnabled(server));
      }}
      data-testid={`mgmt-mcp-enabled-${server.id}`}
      className="inline-flex shrink-0 items-center gap-2 rounded-control px-2 py-2 text-[var(--font-meta-size)] text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {mcp.serverEnabled(server) ? '已启用' : '已停用'}
      <span
        aria-hidden="true"
        className={`flex h-5 w-8 items-center rounded-full border p-0.5 ${mcp.serverEnabled(server) ? 'justify-end border-accent bg-accent' : 'justify-start border-line-strong bg-[var(--surface-card-hover)]'}`}
      >
        <span className="h-3 w-3 rounded-full bg-[var(--control-thumb)]" />
      </span>
    </button>
  );
  const more = (server: McpServerConfig): React.JSX.Element => (
    <details
      className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary
        aria-label={`${server.name} 的更多操作`}
        className={`${actionClass} list-none cursor-pointer [&::-webkit-details-marker]:hidden`}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </summary>
      <div
        className="absolute right-0 top-full z-10 mt-1 w-36 rounded-card border border-line bg-surface p-1 shadow-[var(--shadow-popover)]"
        onClick={(event) => {
          const details = event.currentTarget.closest('details');
          if (details) details.open = false;
        }}
      >
        <button
          type="button"
          className={menuActionClass}
          data-testid={`mgmt-mcp-edit-${server.id}`}
          onClick={() => {
            if (page === 'list') rememberList(server.id);
            setSelectedId(server.id);
            mcp.startEdit(server);
          }}
        >
          编辑配置
        </button>
        <button
          type="button"
          className={menuActionClass}
          data-testid={`mgmt-mcp-test-${server.id}`}
          disabled={mcp.test.pending}
          onClick={() => {
            void mcp.test.run(server.id);
          }}
        >
          校验配置
        </button>
        <button
          type="button"
          className={menuActionClass}
          data-testid={`mgmt-mcp-delete-${server.id}`}
          disabled={mcp.remove.pending}
          onClick={() => setDeleteTarget(server.id)}
        >
          删除服务…
        </button>
      </div>
    </details>
  );

  if (mcp.config === null)
    return (
      <FormNote
        tone={mcp.status === 'error' ? 'warn' : 'default'}
        testId={mcp.status === 'error' ? 'mgmt-mcp-error' : 'mgmt-mcp-loading'}
      >
        {mcp.status === 'error'
          ? `读取 MCP 配置失败：${mcp.error}`
          : '正在读取 MCP 配置…'}
      </FormNote>
    );

  return (
    <div
      ref={root}
      className="flex min-h-0 flex-col gap-4 text-[var(--font-body-size)]"
      data-testid="mgmt-mcp"
    >
      {page === 'list' ? (
        <>
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3
                ref={heading}
                tabIndex={-1}
                className="text-[var(--font-h3-size)] font-semibold text-ink outline-none"
              >
                MCP 服务
              </h3>
              <p
                className="mt-1 text-[var(--font-meta-size)] text-muted"
                data-testid="mgmt-mcp-summary"
              >
                {mcp.rows.length} 个服务 · {enabledCount} 个已启用
              </p>
            </div>
            <button
              type="button"
              className={`${formPrimaryButtonClass} inline-flex items-center gap-1.5`}
              data-testid="mgmt-mcp-create"
              onClick={() => {
                rememberList(null);
                setAdding(true);
              }}
            >
              <Plus size={14} aria-hidden="true" />
              添加服务
            </button>
          </header>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-32 flex-1">
              <span className="sr-only">搜索服务</span>
              <Search
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-2 text-subtle"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索服务…"
                className={`${formInputClass} pl-8`}
                data-testid="mgmt-mcp-search"
              />
            </label>
            <label>
              <span className="sr-only">筛选服务</span>
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value as Filter)}
                className={formInputClass}
                data-testid="mgmt-mcp-filter"
              >
                <option value="all">全部</option>
                <option value="enabled">已启用</option>
                <option value="disabled">已停用</option>
                <option value="issues">需处理</option>
              </select>
            </label>
            <button
              type="button"
              className={actionClass}
              disabled={
                mcp.status === 'loading' || mcp.previewStatus === 'loading'
              }
              data-testid="mgmt-mcp-reload"
              onClick={() => {
                mcp.reload();
                mcp.reloadPreview();
              }}
            >
              <RefreshCw size={13} aria-hidden="true" />
              刷新
            </button>
          </div>
          {issueCount === 0 ? null : (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 self-start rounded-control text-[var(--st-warn)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => {
                setQuery('');
                setFilter('issues');
              }}
            >
              <AlertTriangle size={13} aria-hidden="true" />
              {issueCount} 个服务需处理
            </button>
          )}
          <div data-testid="mgmt-mcp-servers">
            <ul
              className="divide-y divide-line border-y border-line"
              data-testid="mgmt-mcp-rows"
            >
              {visibleRows.map(({ server }) => {
                const issue = issueForServer(server);
                const checked = mcp.test.results[server.id]?.status === 'ready';
                return (
                  <li
                    key={server.id}
                    className="flex items-center gap-1 py-1"
                    data-testid={`mgmt-mcp-server-${server.id}`}
                  >
                    <button
                      type="button"
                      data-server-id={server.id}
                      data-testid={`mgmt-mcp-detail-${server.id}`}
                      onClick={() => {
                        rememberList(server.id);
                        setSelectedId(server.id);
                      }}
                      className="group flex min-w-0 flex-1 items-center gap-3 rounded-control px-2 py-3 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <Server
                        size={18}
                        aria-hidden="true"
                        className="shrink-0 text-[var(--icon-mcp)]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-ink">
                          {server.name}
                        </div>
                        <p className="mt-1 text-[var(--font-meta-size)] text-muted">
                          {server.transport === 'stdio'
                            ? '本地命令'
                            : server.transport.toUpperCase()}{' '}
                          · {toolSummary(server)}
                        </p>
                        <p
                          className={`mt-1 flex items-start gap-1 text-[var(--font-meta-size)] ${issue ? 'text-[var(--st-warn)]' : 'text-subtle'}`}
                          data-testid={`mgmt-mcp-status-${server.id}`}
                        >
                          {issue ? (
                            <AlertTriangle
                              size={12}
                              aria-hidden="true"
                              className="mt-0.5 shrink-0"
                            />
                          ) : checked ? (
                            <Check
                              size={12}
                              aria-hidden="true"
                              className="mt-0.5 shrink-0"
                            />
                          ) : null}
                          <span className="line-clamp-2 break-words">
                            {issue ?? (checked ? '配置已校验' : '尚未校验')}
                          </span>
                        </p>
                      </div>
                      <ChevronRight
                        size={14}
                        aria-hidden="true"
                        className="shrink-0 text-subtle"
                      />
                    </button>
                    {toggle(server)}
                    {more(server)}
                  </li>
                );
              })}
            </ul>
            {visibleRows.length > 0 ? null : (
              <div
                className="flex flex-col items-center gap-2 py-10 text-center text-muted"
                data-testid="mgmt-mcp-empty"
              >
                <Server
                  size={24}
                  aria-hidden="true"
                  className="text-[var(--icon-mcp)]"
                />
                <p>
                  {mcp.rows.length === 0
                    ? '还没有 MCP 服务'
                    : '没有符合条件的服务'}
                </p>
                <p className="text-[var(--font-meta-size)]">
                  {mcp.rows.length === 0
                    ? '添加服务，让助手使用外部工具。'
                    : '试试其他关键词，或查看全部服务。'}
                </p>
                {mcp.rows.length === 0 ? null : (
                  <button
                    type="button"
                    className={actionClass}
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                    }}
                  >
                    清除筛选
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <button
          type="button"
          className={`${actionClass} self-start`}
          disabled={mcp.save.pending || mcp.preset.pending}
          data-testid="mgmt-mcp-back"
          onClick={back}
        >
          <ArrowLeft size={13} aria-hidden="true" />
          服务列表
        </button>
      )}

      {mcp.status !== 'error' ? null : (
        <FormNote tone="warn" testId="mgmt-mcp-error">
          刷新失败：{mcp.error}
        </FormNote>
      )}
      {mcp.save.error === null ? null : (
        <FormNote tone="warn" testId="mgmt-mcp-mutation-error">
          操作失败：{mcp.save.error}
        </FormNote>
      )}

      {page !== 'add' ? null : (
        <section className="flex flex-col gap-3" data-testid="mgmt-mcp-add">
          <h3
            ref={heading}
            tabIndex={-1}
            className="text-[var(--font-h3-size)] font-semibold text-ink outline-none"
          >
            添加服务
          </h3>
          <p className="text-muted">使用预置服务，或填写自己的服务配置。</p>
          <button
            type="button"
            className={`${actionClass} self-start`}
            data-testid="mgmt-mcp-preset"
            disabled={mcp.preset.pending}
            onClick={() => {
              void mcp.preset.run();
            }}
          >
            <Sparkles size={14} aria-hidden="true" />
            {mcp.preset.pending ? '正在添加…' : '使用 Exa 预置'}
          </button>
          <button
            type="button"
            className={`${actionClass} self-start`}
            data-testid="mgmt-mcp-custom"
            onClick={() => mcp.startCreate()}
          >
            <Plus size={14} aria-hidden="true" />
            添加自定义服务
          </button>
        </section>
      )}

      {page !== 'editor' || mcp.draft === null ? null : (
        <McpEditor
          mcp={mcp}
          draft={mcp.draft}
          onSaved={(id) => {
            mcp.cancelEdit();
            setAdding(false);
            setSelectedId(id);
          }}
          onCancel={() => mcp.cancelEdit()}
        />
      )}

      {page !== 'detail' || selected === undefined ? null : (
        <section
          className="flex flex-col gap-5"
          data-testid="mgmt-mcp-service-detail"
        >
          <header className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3
                ref={heading}
                tabIndex={-1}
                className="break-words text-[var(--font-h3-size)] font-semibold text-ink outline-none"
              >
                {selected.server.name}
              </h3>
              <p className="mt-1 text-[var(--font-meta-size)] text-muted">
                {mcp.serverEnabled(selected.server) ? '已启用' : '已停用'} ·{' '}
                {mcpTransportLabels[selected.server.transport]}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {toggle(selected.server)}
              <button
                type="button"
                className={actionClass}
                onClick={() => mcp.startEdit(selected.server)}
                data-testid="mgmt-mcp-edit-config"
              >
                编辑配置
              </button>
              {more(selected.server)}
            </div>
          </header>
          {issueForServer(selected.server) === null ? null : (
            <FormNote tone="warn" testId="mgmt-mcp-service-issue">
              {issueForServer(selected.server)}
            </FormNote>
          )}
          <FormSection
            title="工具"
            testId={`mgmt-mcp-tools-${selected.server.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted" aria-live="polite">
                {toolSummary(selected.server)}
              </p>
              <button
                type="button"
                className={actionClass}
                disabled={mcp.previewStatus === 'loading'}
                onClick={mcp.reloadPreview}
                data-testid="mgmt-mcp-preview-reload"
              >
                <RefreshCw size={13} aria-hidden="true" />
                刷新预览
              </button>
            </div>
            {!mcp.serverEnabled(selected.server) ||
            mcp.previewStatus !== 'ready' ? null : (
              <ul className="divide-y divide-line">
                {manifestToolsForServer(mcp.preview, selected.server.id).map(
                  (tool) => (
                    <li
                      key={tool.name}
                      className="flex items-start justify-between gap-3 py-3"
                    >
                      <span className="min-w-0 break-all font-mono text-[var(--font-code-size)] text-ink">
                        {tool.name}
                      </span>
                      <span className="shrink-0 text-[var(--font-meta-size)] text-muted">
                        {tool.approval === 'required' ? '需要审批' : '免审批'}
                      </span>
                    </li>
                  )
                )}
              </ul>
            )}
            {mcp.serverEnabled(selected.server) &&
            mcp.previewStatus === 'ready' &&
            manifestToolsForServer(mcp.preview, selected.server.id).length ===
              0 ? (
              <p className="py-3 text-muted">
                当前预览没有提供工具。可检查配置或工具限制后刷新预览。
              </p>
            ) : null}
          </FormSection>
          <FormSection title="配置摘要" testId="mgmt-mcp-config-summary">
            <dl className="flex flex-col gap-2">
              <KeyValueRow
                label="服务 ID"
                value={selected.server.id}
                testId="mgmt-mcp-config-id"
              />
              <KeyValueRow
                label={
                  selected.server.transport === 'stdio'
                    ? '启动命令'
                    : '服务地址'
                }
                value={
                  selected.server.command ?? selected.server.url ?? '未填写'
                }
                testId="mgmt-mcp-config-address"
              />
              <KeyValueRow
                label="风险等级"
                value={mcpRiskLabels[selected.server.riskLevel]}
                testId="mgmt-mcp-config-risk"
              />
              <KeyValueRow
                label="工具限制"
                value={selected.server.allowedTools.join(', ') || '不预先限制'}
                testId="mgmt-mcp-config-tools"
              />
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={actionClass}
                disabled={mcp.test.pending}
                onClick={() => {
                  void mcp.test.run(selected.server.id);
                }}
                data-testid="mgmt-mcp-check-config"
              >
                {mcp.test.pending ? '校验中…' : '校验配置'}
              </button>
              <span className="text-[var(--font-meta-size)] text-muted">
                仅检查配置完整性，尚未检查实际连接。
              </span>
            </div>
            {mcp.test.results[selected.server.id] === undefined ? null : (
              <FormNote
                tone={
                  mcp.test.results[selected.server.id]?.status === 'ready'
                    ? 'default'
                    : 'warn'
                }
                testId={`mgmt-mcp-test-result-${selected.server.id}`}
              >
                {mcp.test.results[selected.server.id]?.status === 'ready'
                  ? '配置已校验；尚未检查实际连接。'
                  : mcp.test.results[selected.server.id]?.error}
              </FormNote>
            )}
          </FormSection>
        </section>
      )}

      {mcp.previewError === null ? null : (
        <FormNote tone="warn" testId="mgmt-mcp-preview-error">
          工具预览不可用：{mcp.previewError}
        </FormNote>
      )}
      {page === 'editor' || page === 'add' ? null : (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[var(--font-meta-size)] text-muted">
          <span data-testid="mgmt-mcp-approval-mode">
            {mcpApprovalModeLabels[mcp.config.approvalMode]}
          </span>
          <button
            type="button"
            onClick={scope.openSettings}
            className={actionClass}
            data-testid="mgmt-mcp-open-settings"
          >
            授权设置 ↗
          </button>
        </footer>
      )}
      {page !== 'list' ? null : (
        <details
          className="text-[var(--font-meta-size)] text-muted"
          data-testid="mgmt-mcp-preview"
        >
          <summary className="cursor-pointer rounded-control py-1 focus-visible:outline-2 focus-visible:outline-accent">
            查看助手全部能力
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <p data-testid="mgmt-mcp-preview-summary">
              {previewSummary(mcp.preview)}
            </p>
            <dl>
              <KeyValueRow
                label="内置工具"
                value={builtInTools(mcp.preview).join(', ') || '无'}
                testId="mgmt-mcp-preview-builtin"
              />
              <KeyValueRow
                label="技能"
                value={
                  mcp.preview?.skillCards.map((card) => card.name).join(', ') ||
                  '没有启用的技能'
                }
                testId="mgmt-mcp-preview-skills"
              />
            </dl>
            {skippedCapabilities(mcp.preview).length === 0 ? null : (
              <ul data-testid="mgmt-mcp-preview-skipped">
                {skippedCapabilities(mcp.preview).map((entry) => (
                  <li key={`${entry.type}:${entry.id}`}>
                    {entry.type} {entry.id}：{entry.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个 MCP 服务？"
        message={`将删除 ${deleteRecord?.name ?? deleteTarget ?? ''} 的配置。`}
        detail="删除后助手不能再调用它的工具，服务端内容不受影响。"
        confirmLabel="删除"
        tone="destructive"
        testId="mgmt-mcp-delete-confirm"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target !== null)
            void (async () => {
              if (await mcp.remove.run(target)) {
                if (selectedId === target) back();
              }
            })();
        }}
      />
    </div>
  );
}
