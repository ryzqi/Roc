import type React from 'react';
import type { AppSettings, HostIntegrationStatus } from '../../../shared/types';
import { FieldRow } from '../atoms';

function formatOpenAtLoginHint(hostIntegration: HostIntegrationStatus): string {
  if (hostIntegration.startup.syncError !== null) {
    return `系统实际状态：同步失败，${hostIntegration.startup.syncError}`;
  }
  if (hostIntegration.startup.configuredOpenAtLogin === hostIntegration.startup.effectiveOpenAtLogin) {
    return hostIntegration.startup.effectiveOpenAtLogin
      ? '系统实际状态：已同步，开机启动已写入。'
      : '系统实际状态：已同步，未写入开机启动。';
  }
  return hostIntegration.startup.effectiveOpenAtLogin
    ? '系统实际状态：不一致，系统已写入开机启动。'
    : '系统实际状态：不一致，系统未写入开机启动。';
}

function formatGlobalHotkeyHint(hostIntegration: HostIntegrationStatus): string {
  if (hostIntegration.globalHotkey.accelerator === null) {
    return '系统实际状态：未配置全局快捷键。';
  }
  if (hostIntegration.globalHotkey.registrationError !== null) {
    return `系统实际状态：注册失败，${hostIntegration.globalHotkey.registrationError}`;
  }
  return hostIntegration.globalHotkey.registered
    ? `系统实际状态：已同步，已注册 ${hostIntegration.globalHotkey.accelerator}。`
    : `系统实际状态：不一致，未注册 ${hostIntegration.globalHotkey.accelerator}。`;
}

export function AppBasicsSection({
  draft,
  hostIntegration,
  onChange
}: {
  draft: AppSettings;
  hostIntegration: HostIntegrationStatus;
  onChange: (next: AppSettings) => void;
}): React.JSX.Element {
  return (
    <section className="single-panel settings-section-panel" data-testid="settings-panel-app-basics">
      <div className="section-head">
        <h2 className="section-title">应用基础</h2>
      </div>
      <div className="settings-form">
        <div className="settings-section-group">
          <h3 className="settings-group-title">工作区</h3>
          <FieldRow hint="工作区切换不会自动转移已运行任务，新任务才会绑定新的工作区。" label="默认工作区">
            <input
              data-testid="settings-default-workspace"
              onChange={(event) =>
                onChange({
                  ...draft,
                  defaultWorkspace:
                    event.currentTarget.value.trim().length === 0 ? null : event.currentTarget.value
                })
              }
              placeholder="例如 F:\\Code\\Roc"
              value={draft.defaultWorkspace ?? ''}
            />
          </FieldRow>
        </div>
        <div className="settings-section-group">
          <h3 className="settings-group-title">窗口行为</h3>
          <div className="form-grid">
            <label className="field checkbox-field settings-toggle-row">
              <span>开机启动</span>
              <input
                checked={draft.startup.openAtLogin}
                data-testid="settings-startup-open-at-login"
                onChange={(event) =>
                  onChange({
                    ...draft,
                    startup: {
                      ...draft.startup,
                      openAtLogin: event.currentTarget.checked
                    }
                  })
                }
                type="checkbox"
              />
              <small className="field-hint">{formatOpenAtLoginHint(hostIntegration)}</small>
            </label>
            <label className="field checkbox-field settings-toggle-row">
              <span>最小化到托盘</span>
              <input
                checked={draft.startup.minimizeToTray}
                data-testid="settings-startup-minimize-to-tray"
                onChange={(event) =>
                  onChange({
                    ...draft,
                    startup: {
                      ...draft.startup,
                      minimizeToTray: event.currentTarget.checked
                    }
                  })
                }
                type="checkbox"
              />
              <small className="field-hint">关闭主窗口后保持后台驻留。</small>
            </label>
          </div>
        </div>
        <div className="settings-section-group">
          <h3 className="settings-group-title">全局入口</h3>
          <FieldRow
            hint={formatGlobalHotkeyHint(hostIntegration)}
            label="全局快捷键"
          >
            <input
              data-testid="settings-global-hotkey"
              onChange={(event) => {
                const value = event.currentTarget.value.trim();
                onChange({
                  ...draft,
                  globalHotkey: value.length === 0 ? null : value
                });
              }}
              placeholder="例如 Ctrl+Shift+Space"
              value={draft.globalHotkey ?? ''}
            />
          </FieldRow>
        </div>
      </div>
    </section>
  );
}
