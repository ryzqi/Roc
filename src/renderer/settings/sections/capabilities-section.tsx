import type React from 'react';
import type { McpServerSnapshot, SkillSnapshot } from '../../../shared/types';
import { InfoRow, StatusPill } from '../atoms';

export function CapabilitiesSection({
  mcpServers,
  onNavigate,
  skills
}: {
  mcpServers: McpServerSnapshot[];
  onNavigate: (target: 'mcp' | 'skills') => void;
  skills: SkillSnapshot[];
}): React.JSX.Element {
  const enabledMcp = mcpServers.filter((server) => server.enabled).length;
  const errorMcp = mcpServers.filter((server) => server.lastError !== null && server.lastError !== undefined).length;
  const readySkills = skills.filter((skill) => skill.enabled && skill.status === 'ready').length;
  const invalidSkills = skills.filter((skill) => skill.status === 'invalid').length;
  return (
    <section className="single-panel settings-section-panel" data-testid="settings-panel-capabilities">
      <div className="section-head">
        <h2 className="section-title">能力入口</h2>
      </div>
      <div className="settings-form">
        <p className="card-hint">
          设置页只提供入口与健康摘要；具体新增、启停、授权、测试和删除请到能力管理视图。
        </p>
        <div className="row action-row">
          <div>
            <div className="row-title">MCP 服务</div>
            <div className="row-sub">
              已启用 {enabledMcp} 个，共 {mcpServers.length} 个
            </div>
          </div>
          <StatusPill label="错误" tone={errorMcp > 0 ? 'warn' : 'ok'} value={String(errorMcp)} />
          <button
            data-testid="settings-capabilities-open-mcp"
            onClick={() => onNavigate('mcp')}
            type="button"
          >
            打开 MCP 管理
          </button>
        </div>
        <div className="row action-row">
          <div>
            <div className="row-title">Skill 能力包</div>
            <div className="row-sub">
              可用 {readySkills} 个，共 {skills.length} 个
            </div>
          </div>
          <StatusPill label="无效" tone={invalidSkills > 0 ? 'warn' : 'ok'} value={String(invalidSkills)} />
          <button
            data-testid="settings-capabilities-open-skills"
            onClick={() => onNavigate('skills')}
            type="button"
          >
            打开 Skill 管理
          </button>
        </div>
        {mcpServers.length === 0 && skills.length === 0 ? (
          <InfoRow
            sub="尚未配置 MCP 服务或 Skill 能力包。打开能力管理以新增。"
            tag="empty"
            title="状态"
            tone="info"
          />
        ) : null}
      </div>
    </section>
  );
}
