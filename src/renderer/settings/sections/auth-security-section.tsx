import type React from 'react';
import type { PermissionConfirmationPolicy, PermissionsConfig } from '../../../shared/types';
import { FieldRow, InfoRow } from '../atoms';

const fields: Array<{
  key: keyof PermissionsConfig['defaultConfirmations'];
  label: string;
  hint: string;
}> = [
  {
    key: 'workspaceOutsideWrite',
    label: '工作区外写入',
    hint: '影响 agent 修改、删除、移动工作区外文件时是否始终弹出确认。'
  },
  {
    key: 'workspaceOutsideShell',
    label: '工作区外执行命令',
    hint: '影响 agent 在工作区外发起命令时是否始终弹出确认。'
  },
  {
    key: 'gitPush',
    label: 'Git push',
    hint: '影响远端推送是否始终弹出确认；本地 commit 不受此项影响。'
  },
  {
    key: 'memoryDelete',
    label: '删除记忆',
    hint: '影响删除有效记忆条目时是否始终弹出确认；候选记忆删除不受影响。'
  }
];

export function AuthSecuritySection({
  draft,
  onChange
}: {
  draft: PermissionsConfig;
  onChange: (next: PermissionsConfig) => void;
}): React.JSX.Element {
  function setConfirmation(
    key: keyof PermissionsConfig['defaultConfirmations'],
    value: PermissionConfirmationPolicy
  ): void {
    onChange({
      ...draft,
      defaultConfirmations: {
        ...draft.defaultConfirmations,
        [key]: value
      }
    });
  }

  return (
    <section className="card" data-testid="settings-panel-auth-security">
      <div className="card-title">授权与安全</div>
      <div className="card-pad settings-form">
        <p className="card-hint">
          这些开关只决定默认确认规则的策略偏好；任务运行时的实际决策仍由权限服务在工具调用前裁决。
        </p>
        <div className="form-grid">
          {fields.map((field) => (
            <FieldRow hint={field.hint} key={field.key} label={field.label}>
              <select
                data-testid={`settings-confirmation-${field.key}`}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value === 'always_confirm' || value === 'never_confirm') {
                    setConfirmation(field.key, value);
                  }
                }}
                value={draft.defaultConfirmations[field.key]}
              >
                <option value="always_confirm">始终确认</option>
                <option value="never_confirm">不确认</option>
              </select>
            </FieldRow>
          ))}
        </div>
      </div>
      <div className="card-pad">
        <div className="card-title secondary">长期授权</div>
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
