import { ContentPreferences } from './ContentPreferences';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import type { ThemeOverride } from '../../app/ui-state';
import { themeOverrideLabel } from '../../shell/appearance';
import type { SettingsStore } from '../settings-scope';
import {
  getAppStatus,
  getSchedulerStatus,
  getTraySummary,
  pauseBackgroundExecution,
  resumeBackgroundExecution
} from '../settings-store';
import {
  CheckboxField,
  KeyValueRow,
  NumberField,
  FormNote,
  FormSection,
  TextField,
  formSecondaryButtonClass
} from '../../shared/form-ui';

/**
 * 应用基础，任务与调度 (T8.3).
 *
 * 应用基础 writes two `appSettingsSchema` fields the main process actually applies —
 * `startup.openAtLogin` (through `macos-host-service`) and `globalHotkey` (`globalShortcut`) —
 * and reports `hostIntegration`, which is the only honest source for "did the registration
 * succeed". 外观 is a renderer UI preference and stays in `ui-state.ts`: it is
 * applied immediately, not drafted, because it has no backend field to save.
 *
 * Content size and density are renderer preferences with live token consumers; they
 * persist through ui-state independently of the backend settings draft.
 */

export function AppSection({
  store,
  themeOverride,
  onThemeOverrideChange
}: {
  store: SettingsStore;
  themeOverride: ThemeOverride;
  onThemeOverrideChange: (next: ThemeOverride) => void;
}): React.JSX.Element {
  const draft = store.draft;
  const app = useAsyncResource('settings:app-status', () => getAppStatus(store.client), { label: '读取应用状态' });

  if (draft === null) {
    return <FormNote testId="settings-app-unavailable">设置尚未读取完成。</FormNote>;
  }
  const host = store.snapshot?.hostIntegration ?? null;
  const status = app.data;

  return (
    <FormSection
      title="应用基础"
      testId="settings-section-app-body"
    >
      {app.error === null ? null : (
        <FormNote tone="warn" testId="settings-app-status-error">
          {app.error}
        </FormNote>
      )}
      <dl className="flex flex-col gap-0.5">
        <KeyValueRow
          label="应用"
          value={status === null ? '读取中…' : `${status.appName} ${status.version}`}
          testId="settings-app-status"
        />
        <KeyValueRow
          label="默认模型"
          value={status === null ? '读取中…' : status.defaultModelConfigured ? '已配置' : '未配置'}
          testId="settings-app-default-model"
        />
      </dl>

      <div className="flex flex-col gap-2 border-t border-line pt-2">
        <CheckboxField
          label="开机时启动 Roc"
          checked={draft.settings.startup.openAtLogin}
          onChange={(openAtLogin) =>
            store.update((next) => void (next.settings.startup.openAtLogin = openAtLogin))
          }
          description={
            host === null
              ? undefined
              : `系统实际状态：${host.startup.effectiveOpenAtLogin ? '已启用' : '未启用'}${
                  host.startup.syncError === null ? '' : `，同步错误：${host.startup.syncError}`
                }`
          }
          testId="settings-open-at-login"
        />
        {host !== null && host.startup.syncError !== null ? (
          <FormNote tone="warn" testId="settings-open-at-login-error">
            写入系统登录项失败：{host.startup.syncError}
          </FormNote>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-2">
        <div className="max-w-[320px]">
          <TextField
            label="全局热键（留空表示不注册）"
            value={draft.settings.globalHotkey ?? ''}
            placeholder="例如 CommandOrControl+Shift+R"
            onChange={(value) =>
              store.update((next) => void (next.settings.globalHotkey = value.trim().length === 0 ? null : value))
            }
            testId="settings-global-hotkey"
          />
        </div>
        <dl className="flex flex-col gap-0.5">
          <KeyValueRow
            label="注册状态"
            value={
              host === null
                ? '读取中…'
                : host.globalHotkey.registered
                  ? `已注册（${host.globalHotkey.accelerator ?? draft.settings.globalHotkey ?? '—'}）`
                  : '未注册'
            }
            testId="settings-hotkey-registered"
          />
        </dl>
        {host !== null && host.globalHotkey.registrationError !== null ? (
          <FormNote tone="warn" testId="settings-hotkey-error">
            注册失败：{host.globalHotkey.registrationError}
          </FormNote>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-2">
        <div className="flex flex-wrap gap-2">
          {(['system', 'light', 'dark'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={themeOverride === option}
              data-testid={`settings-theme-${option}`}
              onClick={() => onThemeOverrideChange(option)}
              className={
                themeOverride === option
                  ? 'h-[var(--control-height)] rounded-control bg-accent-soft px-3 text-ink'
                  : `${formSecondaryButtonClass} h-[var(--control-height)] px-3`
              }
            >
              {themeOverrideLabel(option)}
            </button>
          ))}
        </div>
      </div>
      <ContentPreferences />
    </FormSection>
  );
}

export function TasksSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const draft = store.draft;
  const scheduler = useAsyncResource('settings:scheduler', () => getSchedulerStatus(store.client), {
    label: '读取调度器状态'
  });
  const tray = useAsyncResource('settings:tray', () => getTraySummary(store.client), { label: '读取后台执行状态' });

  const pause = useAsyncAction(() => pauseBackgroundExecution(store.client), { label: '暂停后台执行' });
  const resume = useAsyncAction(() => resumeBackgroundExecution(store.client), { label: '恢复后台执行' });

  if (draft === null) {
    return <FormNote testId="settings-tasks-unavailable">设置尚未读取完成。</FormNote>;
  }
  const tasks = draft.settings.tasks;
  const schedulerStatus = scheduler.data;
  const trayStatus = tray.data;

  return (
    <FormSection
      title="任务与调度"
      testId="settings-section-tasks-body"
    >
      <h4 className="text-ink text-[var(--font-meta-size)]">长任务判定阈值</h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <NumberField
          label="运行秒数"
          value={tasks.longRunningThresholds.runningSeconds}
          min={0}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.tasks.longRunningThresholds.runningSeconds = value;
              }
            })
          }
          testId="settings-long-running-seconds"
        />
        <NumberField
          label="工具调用次数"
          value={tasks.longRunningThresholds.toolCallCount}
          min={0}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.tasks.longRunningThresholds.toolCallCount = value;
              }
            })
          }
          testId="settings-long-running-tools"
        />
        <NumberField
          label="子代理数量"
          value={tasks.longRunningThresholds.subagentCount}
          min={0}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.tasks.longRunningThresholds.subagentCount = value;
              }
            })
          }
          testId="settings-long-running-subagents"
        />
      </div>

      <h4 className="text-ink text-[var(--font-meta-size)]">调度器</h4>
      <div className="flex flex-wrap items-end gap-3">
        <CheckboxField
          label="启动时补跑错过的任务"
          checked={tasks.scheduler.catchUpOnStartup}
          onChange={(catchUpOnStartup) =>
            store.update((next) => void (next.settings.tasks.scheduler.catchUpOnStartup = catchUpOnStartup))
          }
          testId="settings-scheduler-catchup"
        />
        <NumberField
          label="最多注册任务数"
          value={tasks.scheduler.maxRegisteredTasks}
          min={1}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.tasks.scheduler.maxRegisteredTasks = value;
              }
            })
          }
          testId="settings-scheduler-max-tasks"
        />
      </div>

      <div className="border-t border-line pt-2">
        {scheduler.error === null ? null : (
          <FormNote tone="warn" testId="settings-scheduler-error">
            {scheduler.error}
          </FormNote>
        )}
        <dl className="flex flex-col gap-0.5">
          <KeyValueRow
            label="调度器"
            value={schedulerStatus === null ? '读取中…' : schedulerStatus.running ? '运行中' : '已停止'}
            testId="settings-scheduler-running"
          />
          <KeyValueRow
            label="已注册任务"
            value={schedulerStatus === null ? '读取中…' : String(schedulerStatus.registeredTaskCount)}
            testId="settings-scheduler-registered"
          />
          <KeyValueRow
            label="下次触发"
            value={schedulerStatus?.nextFireAt ?? '—'}
            testId="settings-scheduler-next"
          />
          <KeyValueRow
            label="最近跳过"
            value={schedulerStatus === null ? '读取中…' : String(schedulerStatus.recentSkippedCount)}
            testId="settings-scheduler-skipped"
          />
          <KeyValueRow label="调度错误" value={schedulerStatus?.lastError ?? '无'} testId="settings-scheduler-last-error" />
        </dl>
      </div>

      <div className="border-t border-line pt-2">
        {tray.error === null ? null : (
          <FormNote tone="warn" testId="settings-tray-error">
            {tray.error}
          </FormNote>
        )}
        <dl className="flex flex-col gap-0.5">
          <KeyValueRow
            label="后台执行"
            value={
              trayStatus === null ? '读取中…' : trayStatus.backgroundPaused ? '已暂停（用户暂停）' : '运行中'
            }
            testId="settings-background-state"
          />
          <KeyValueRow
            label="后台任务"
            value={
              trayStatus === null
                ? '读取中…'
                : `共 ${trayStatus.backgroundTasks.total}，运行 ${trayStatus.backgroundTasks.running}，失败 ${trayStatus.backgroundTasks.failed}，待确认 ${trayStatus.backgroundTasks.pendingConfirmation}`
            }
            testId="settings-background-tasks"
          />
          <KeyValueRow label="常驻" value={trayStatus === null ? '读取中…' : trayStatus.residentEnabled ? '已启用' : '未启用'} testId="settings-resident" />
        </dl>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            data-testid="settings-background-pause"
            disabled={pause.pending || trayStatus === null || trayStatus.backgroundPaused}
            onClick={() => {
              void pause.run().then((result) => {
                if (result !== null) {
                  tray.reload();
                }
              });
            }}
            className={formSecondaryButtonClass}
          >
            暂停后台执行
          </button>
          <button
            type="button"
            data-testid="settings-background-resume"
            disabled={resume.pending || trayStatus === null || !trayStatus.backgroundPaused}
            onClick={() => {
              void resume.run().then((result) => {
                if (result !== null) {
                  tray.reload();
                }
              });
            }}
            className={formSecondaryButtonClass}
          >
            恢复后台执行
          </button>
        </div>
        {pause.error === null ? null : (
          <FormNote tone="warn" testId="settings-background-pause-error">
            {pause.error}
          </FormNote>
        )}
        {resume.error === null ? null : (
          <FormNote tone="warn" testId="settings-background-resume-error">
            {resume.error}
          </FormNote>
        )}
      </div>
    </FormSection>
  );
}
