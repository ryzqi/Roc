import type { McpServerConfig } from '../../../shared/types';
import {
  FormNote,
  TextField,
  formInputClass,
  formPrimaryButtonClass,
  formSecondaryButtonClass,
  formTextAreaClass
} from '../../shared/form-ui';
import { issueFor, type McpDraft } from '../mcp-model';
import type { McpStore } from '../use-mcp';

/** Keep configuration out of the browsing surface; only expose fields the backend accepts. */
export function McpEditor({
  mcp,
  draft,
  onSaved,
  onCancel
}: {
  mcp: McpStore;
  draft: McpDraft;
  onSaved: (id: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const update = (next: Partial<McpDraft>): void =>
    mcp.setDraft({ ...draft, ...next });
  const advancedIssue = mcp.issues.some(
    (issue) => issue.field === 'id' || issue.field === 'allowedToolsText'
  );
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="mgmt-mcp-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          if (await mcp.save.run()) onSaved(draft.id.trim());
        })();
      }}
    >
      <h3 className="text-[var(--font-h3-size)] font-semibold text-ink">
        {mcp.editingId === null ? '添加自定义服务' : '编辑配置'}
      </h3>
      <fieldset
        disabled={mcp.save.pending}
        className="flex min-w-0 flex-col gap-4 disabled:opacity-50"
      >
        <TextField
          label="服务名称"
          value={draft.name}
          onChange={(name) => update({ name })}
          issue={issueFor(mcp.issues, 'name')}
          testId="mgmt-mcp-draft-name"
        />
        <label className="flex flex-col gap-1 text-muted">
          连接方式
          <select
            value={draft.transport}
            onChange={(event) =>
              update({
                transport: event.target.value as McpServerConfig['transport']
              })
            }
            className={formInputClass}
            data-testid="mgmt-mcp-draft-transport"
          >
            <option value="stdio">本地命令（stdio）</option>
            <option value="http">HTTP</option>
            <option value="sse">SSE</option>
          </select>
        </label>
        {draft.transport === 'stdio' ? (
          <TextField
            label="启动命令"
            value={draft.command}
            onChange={(command) => update({ command })}
            issue={issueFor(mcp.issues, 'command')}
            testId="mgmt-mcp-draft-command"
            placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp"
          />
        ) : (
          <TextField
            label="服务地址"
            value={draft.url}
            onChange={(url) => update({ url })}
            issue={issueFor(mcp.issues, 'url')}
            testId="mgmt-mcp-draft-url"
            placeholder="https://mcp.example.com/mcp"
          />
        )}
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
            data-testid="mgmt-mcp-draft-enabled"
            className="accent-[var(--accent)]"
          />
          启用该服务
        </label>
        <details
          className="border-t border-line pt-3"
          open={advancedIssue || undefined}
        >
          <summary className="cursor-pointer rounded-control text-muted focus-visible:outline-2 focus-visible:outline-accent">
            高级设置
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            <TextField
              label="服务 ID"
              value={draft.id}
              disabled={mcp.editingId !== null}
              onChange={(id) => update({ id })}
              issue={issueFor(mcp.issues, 'id')}
              testId="mgmt-mcp-draft-id"
            />
            <label className="flex flex-col gap-1 text-muted">
              风险等级
              <select
                value={draft.riskLevel}
                onChange={(event) =>
                  update({
                    riskLevel: event.target
                      .value as McpServerConfig['riskLevel']
                  })
                }
                className={formInputClass}
                data-testid="mgmt-mcp-draft-risk"
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-muted">
              允许的工具
              <span className="text-[var(--font-meta-size)]">
                每行一个工具名，留空表示不预先限制。
              </span>
              <textarea
                value={draft.allowedToolsText}
                onChange={(event) =>
                  update({ allowedToolsText: event.target.value })
                }
                rows={4}
                className={formTextAreaClass}
                data-testid="mgmt-mcp-draft-tools"
              />
              {issueFor(mcp.issues, 'allowedToolsText') === null ? null : (
                <FormNote tone="warn" testId="mgmt-mcp-issue-allowedToolsText">
                  {issueFor(mcp.issues, 'allowedToolsText')}
                </FormNote>
              )}
            </label>
          </div>
        </details>
      </fieldset>
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-surface py-3">
        <button
          type="submit"
          disabled={mcp.save.pending || mcp.issues.length > 0}
          className={formPrimaryButtonClass}
          data-testid="mgmt-mcp-save"
        >
          {mcp.save.pending ? '保存中…' : '保存服务'}
        </button>
        <button
          type="button"
          disabled={mcp.save.pending}
          onClick={onCancel}
          className={formSecondaryButtonClass}
          data-testid="mgmt-mcp-cancel"
        >
          取消
        </button>
      </div>
    </form>
  );
}
