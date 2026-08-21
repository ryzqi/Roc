import type React from 'react';
import type { ApprovalMode, PermissionsConfig } from '../../../shared/types';
import { Radio } from '../../components/ui';
import { InfoRow } from '../atoms';

const approvalModes: Array<{
  value: ApprovalMode;
  title: string;
  description: string;
  testId: string;
}> = [
  {
    value: 'fully_automatic',
    title: '全自动',
    description: '直接执行 delete_file；删除文件不再默认弹出审批卡。',
    testId: 'settings-approval-mode-fully-automatic'
  },
  {
    value: 'default',
    title: '默认',
    description: '仅在 delete_file 调用前弹出审批卡；execute、web_read 与记忆工具保持直通。',
    testId: 'settings-approval-mode-default'
  }
];

export function AuthSecuritySection({
  draft,
  onChange
}: {
  draft: PermissionsConfig;
  onChange: (next: PermissionsConfig) => void;
}): React.JSX.Element {
  function setApprovalMode(mode: ApprovalMode): void {
    onChange({
      ...draft,
      mode
    });
  }

  return (
    <section className="single-panel settings-section-panel" data-testid="settings-panel-auth-security">
      <div className="section-head">
        <h2 className="section-title">授权与安全</h2>
      </div>
      <div className="settings-form">
        <p className="card-hint">
          这里控制 Roc 内置 delete_file 的审批策略。运行时是否中断并展示审批卡，会按当前模式决定。
        </p>
        <div className="form-grid">
          {approvalModes.map((option) => (
            <div className="field" key={option.value}>
              <Radio
                checked={draft.mode === option.value}
                data-testid={option.testId}
                name="settings-approval-mode"
                onChange={() => setApprovalMode(option.value)}
                value={option.value}
              >{option.title}</Radio>
              <small className="field-hint">{option.description}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="settings-subsection">
        <div className="section-head">
          <h3 className="section-title">长期授权</h3>
        </div>
        {draft.grants.length === 0 ? (
          <InfoRow
            sub="目前没有长期授权记录；任务运行中授予的长期授权会出现在这里。"
            tag="empty"
            title="grants"
            tone="info"
          />
        ) : (
          <ul className="grant-list">
            {draft.grants.map((grant, index) => (
              <li key={index}>{JSON.stringify(grant)}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
