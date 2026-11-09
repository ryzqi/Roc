import { useState } from 'react';
import { FlaskConical, RotateCcw } from 'lucide-react';
import type { PilotProfile } from '../../../shared/schemas/harness-pilot';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import {
  FormNote,
  FormSection,
  NumberField,
  formSecondaryButtonClass,
  formSelectClass
} from '../../shared/form-ui';
import type { RocClient } from '../../shared/roc-client';

/** Explicit pilot opt-in and reversible failure breaker. */

const profileLabels: Record<PilotProfile, string> = {
  'read-only': '只读（禁止写工作区、宿主机命令与网络读取）',
  'low-side-effect': '低副作用（允许声明的工作区写入，仍禁止外部调用/宿主机/网络读取）'
};

export function PilotSection({ client }: { client: RocClient }): React.JSX.Element {
  const status = useAsyncResource('pilot', () => client.api.agent.getPilotStatus(), { label: '读取受限试点' });
  const [profile, setProfile] = useState<PilotProfile>('read-only');
  const [rolloutPercent, setRolloutPercent] = useState(10);

  const enable = useAsyncAction(
    (request: { profile: PilotProfile; rolloutPercent: number }) =>
      client.api.agent.enablePilot(request),
    { label: '开启受限试点' }
  );
  const rollback = useAsyncAction(() => client.api.agent.rollbackPilot(), { label: '回退受限试点' });

  const data = status.data;
  const busy = enable.pending || rollback.pending;

  const runAction = (action: 'enable' | 'rollback'): void => {
    void (async () => {
      if (action === 'rollback') {
        const result = await rollback.run();
        if (result.ok) status.reload();
        return;
      }
      const result = await enable.run({
        profile,
        rolloutPercent
      });
      if (result.ok) status.reload();
    })();
  };

  if (status.status === 'error') {
    return (
      <FormNote tone="warn" testId="settings-pilot-error">
        {status.error ?? '读取受限试点状态失败。'}
        <button type="button" onClick={() => status.reload()} className={`${formSecondaryButtonClass} ml-2`}>
          重试
        </button>
      </FormNote>
    );
  }

  if (data === null) {
    return <FormNote testId="settings-pilot-loading">正在读取受限试点状态…</FormNote>;
  }

  const settings = data.settings;
  const actionError = enable.error ?? rollback.error;

  return (
    <FormSection
      title="受限试点"
      testId="settings-section-pilot-body"
    >
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--font-meta-size)]" data-testid="settings-pilot-state">
        <span className="text-subtle text-[length:var(--font-micro-size)]">当前状态</span>
        <span className="text-ink">{settings.enabled ? `已开启，${settings.profile}` : '已关闭'}</span>
        {settings.circuitOpen ? (
          <span className="text-[var(--st-warn)]">
            熔断中{settings.breakerReason === null ? '' : `，${settings.breakerReason}`}
          </span>
        ) : null}
        <span className="text-subtle">
          失败连击 {settings.failureStreak}/{settings.maxFailureStreak}
        </span>
      </div>

      <label className="flex max-w-[520px] flex-col gap-0.5">
        <span className="text-subtle text-[length:var(--font-micro-size)]">配置文件</span>
        <select
          value={profile}
          onChange={(event) => setProfile(event.target.value as PilotProfile)}
          data-testid="settings-pilot-profile"
          className={formSelectClass}
          disabled={busy}
        >
          <option value="read-only">{profileLabels['read-only']}</option>
          <option value="low-side-effect">{profileLabels['low-side-effect']}</option>
        </select>
      </label>

      <div className="flex flex-wrap gap-3">
        <div className="w-[180px]">
          <NumberField
            label="分桶比例（%）"
            value={rolloutPercent}
            onChange={(next) => setRolloutPercent(next === null || next === undefined ? 1 : next)}
            min={1}
            max={100}
            disabled={busy}
            testId="settings-pilot-rollout"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="settings-pilot-enable"
          disabled={busy}
          onClick={() => runAction('enable')}
          className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
        >
          <FlaskConical size={11} aria-hidden="true" />
          {enable.pending ? '开启中…' : '开启试点'}
        </button>
        <button
          type="button"
          data-testid="settings-pilot-rollback"
          disabled={busy || (!settings.enabled && !settings.circuitOpen)}
          onClick={() => runAction('rollback')}
          className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
        >
          <RotateCcw size={11} aria-hidden="true" />
          {rollback.pending ? '回退中…' : '关闭并回退'}
        </button>
      </div>

      {actionError === null ? null : (
        <FormNote tone="warn" testId="settings-pilot-action-error">
          {actionError}
        </FormNote>
      )}
      {data.lastRun === null ? null : (
        <div
          className="flex flex-col gap-0.5 text-[length:var(--font-meta-size)] text-muted"
          data-testid="settings-pilot-last-run"
        >
          <span className="text-subtle text-[length:var(--font-micro-size)]">最近一次试点运行</span>
          <span>
            <span className="font-mono">{data.lastRun.runId}</span>，{data.lastRun.profile ?? '无配置'}，分桶{' '}
            {data.lastRun.bucket}，{data.lastRun.state}
          </span>
          <span className="text-subtle">当次披露：{data.lastRun.disclosure}</span>
        </div>
      )}

    </FormSection>
  );
}
