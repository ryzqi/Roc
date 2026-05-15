import type React from 'react';
import type { McpServerSnapshot } from '../../../shared/types';
import { InfoRow, StatusPill } from '../atoms';

export function BrowserSection({
  exaServer,
  onTestExa,
  testStatusLabel
}: {
  exaServer: McpServerSnapshot | null;
  onTestExa: () => Promise<void>;
  testStatusLabel: string;
}): React.JSX.Element {
  return (
    <section className="single-panel settings-section-panel" data-testid="settings-panel-browser">
      <div className="section-head">
        <h2 className="section-title">网页与浏览器</h2>
      </div>
      <div className="settings-form">
        <p className="card-hint">
          搜索走 Exa 官方 Hosted MCP；网页阅读走主进程内置 Jina Reader，读取链路固定为 r.jina.ai/&lt;url&gt;。
        </p>
        <div className="row action-row" data-testid="settings-browser-exa-row">
          <div>
            <div className="row-title">Exa Hosted MCP</div>
            <div className="row-sub">
              {exaServer === null
                ? '未注册预设；切到「能力入口」可初始化 Exa 预设。'
                : `${exaServer.url ?? '未配置 URL'} · ${exaServer.enabled ? '已启用' : '未启用'}`}
            </div>
          </div>
          <StatusPill
            label="测试"
            tone={testStatusLabel === 'ready' ? 'ok' : testStatusLabel === 'invalid' ? 'warn' : 'info'}
            value={testStatusLabel}
          />
          <button
            data-testid="settings-browser-exa-test"
            disabled={exaServer === null}
            onClick={() => void onTestExa()}
            type="button"
          >
            测试连接
          </button>
        </div>
        <InfoRow
          sub="Jina Reader 已内置；按需读取公开网页正文，支持 no-cache 和 readerlm-v2 响应模式。"
          tag="已内置"
          title="网页阅读 (Jina Reader)"
          tone="ok"
        />
        <InfoRow
          sub="搜索结果与网页正文均标记为不可信上下文，未经显式整理不会进入长期记忆。"
          tag="允许范围"
          title="不可信上下文策略"
          tone="info"
        />
      </div>
    </section>
  );
}
