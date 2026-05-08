import type React from 'react';
import type { AppSettings } from '../../../shared/types';
import { FieldRow } from '../atoms';

export function AppBasicsSection({
  draft,
  onChange
}: {
  draft: AppSettings;
  onChange: (next: AppSettings) => void;
}): React.JSX.Element {
  return (
    <section className="card" data-testid="settings-panel-app-basics">
      <div className="card-title">应用基础</div>
      <div className="card-pad settings-form">
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
        <div className="form-grid">
          <label className="field checkbox-field">
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
          </label>
          <label className="field checkbox-field">
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
          </label>
          <label className="field checkbox-field">
            <span>低打扰通知</span>
            <input
              checked={draft.notifications.lowDistraction}
              data-testid="settings-notifications-low-distraction"
              onChange={(event) =>
                onChange({
                  ...draft,
                  notifications: {
                    lowDistraction: event.currentTarget.checked
                  }
                })
              }
              type="checkbox"
            />
          </label>
        </div>
        <FieldRow
          hint="本版本仅保存键位字符串，不会自动注册系统级快捷键；后续会接入 globalShortcut。"
          label="全局快捷入口"
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
    </section>
  );
}
