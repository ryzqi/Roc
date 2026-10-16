import { useMemo } from 'react';
import { parseProviderModelKey } from '../../../shared/provider-model-key';
import { modelOptions } from '../settings-rules';
import type { SettingsStore } from '../settings-scope';
import { SettingsNote, SettingsSection, settingsInputClass } from '../settings-ui';

/**
 * 默认模型 (T8.3).
 *
 * `defaultModelId` lives in the same whole-save document as `providers`, so this section is
 * a view onto one field — but it is a separate section because it is one of the three
 * high-impact settings (T8.2) and because the backend sanitises it: a default pointing at a
 * disabled provider or model is silently reset to null on save
 * (`sanitizeDefaultModelId`), which is exactly the kind of change the surface must not hide.
 */

export function DefaultModelSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const draft = store.draft;
  const options = useMemo(() => modelOptions(draft?.providers ?? []), [draft]);
  const enabledOptions = useMemo(() => options.filter((option) => option.enabled), [options]);
  const current = draft?.defaultModelId ?? null;
  const parsed = current === null ? null : parseProviderModelKey(current);
  const resolvable = useMemo(
    () => (current === null ? true : enabledOptions.some((option) => option.key === current)),
    [current, enabledOptions]
  );

  if (draft === null) {
    return <SettingsNote testId="settings-default-model-unavailable">设置尚未读取完成。</SettingsNote>;
  }

  return (
    <SettingsSection
      title="默认模型"
      hint="settings.save 的 defaultModelId；未配置时需要模型的入口会先要求配置"
      testId="settings-section-default-model-body"
    >
      <label className="flex max-w-[420px] flex-col gap-0.5">
        <span className="text-subtle text-[var(--font-micro-size)]">默认模型</span>
        <select
          value={current ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            store.update((draftState) => {
              draftState.defaultModelId = next.length === 0 ? null : next;
            });
          }}
          data-testid="settings-default-model-select"
          className={settingsInputClass}
        >
          <option value="">（未配置）</option>
          {enabledOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="text-subtle text-[var(--font-micro-size)]">
          格式为 <span className="font-mono">provider:model</span>
          {parsed === null ? null : `（当前：${parsed.providerId} / ${parsed.modelId}）`}
        </span>
      </label>

      {resolvable ? null : (
        <SettingsNote tone="warn" testId="settings-default-model-unresolvable">
          当前默认模型 {current} 不在已启用（且被启用）的模型里；后端保存时会把它清空为「未配置」。请改选一个，或到
          「模型与服务」启用它。
        </SettingsNote>
      )}

      {current === null ? (
        <SettingsNote testId="settings-default-model-missing">
          未配置默认模型：助手的新会话与阶段运行都会要求先在这里选一个。
        </SettingsNote>
      ) : null}

      <SettingsNote testId="settings-default-model-impact">
        改动默认模型只影响之后新建的会话与阶段运行；正在进行的运行继续用启动时的模型。
      </SettingsNote>
    </SettingsSection>
  );
}
