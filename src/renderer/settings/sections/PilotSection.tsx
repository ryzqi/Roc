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

/**
 * 受限试点 (P6-04).
 *
 * The pilot is *not* part of the whole-save settings document: it has its own durable state
 * (`agent.pilot.*`), because turning it on is a runtime execution decision rather than a
 * preference field. Three rules shape this surface:
 *
 *  1. **Opt-in discloses the extra allowance.** Enabling requires a microusd ceiling *and* an
 *     explicit acknowledgement; the button stays disabled until both are given.
 *  2. **Cost is declared unknown.** Roc has no price table, so the surface says so instead of
 *     showing a fabricated amount. The allowance it can actually meter (model calls, tool calls,
 *     tokens) is shown as numbers.
 *  3. **The breaker is visible and reversible.** A tripped breaker names its reason, and
 *     「关闭并回退」 is always available; it both disables the pilot and keeps the breaker open
 *     until a fresh opt-in, so nothing restarts silently.
 */

const profileLabels: Record<PilotProfile, string> = {
  'read-only': '只读（禁止写工作区、宿主机命令与网络读取）',
  'low-side-effect': '低副作用（允许声明的工作区写入，仍禁止外部调用/宿主机/网络读取）'
};

export function PilotSection({ client }: { client: RocClient }): React.JSX.Element {
  const status = useAsyncResource('pilot', () => client.api.agent.getPilotStatus(), { label: '读取受限试点' });
  const [profile, setProfile] = useState<PilotProfile>('read-only');
  const [rolloutPercent, setRolloutPercent] = useState(10);
  const [extraBudgetMicrousd, setExtraBudgetMicrousd] = useState(200);
  const [acknowledged, setAcknowledged] = useState(false);

  const enable = useAsyncAction(
    (request: { profile: PilotProfile; rolloutPercent: number; extraBudgetMicrousd: number; budgetAcknowledged: boolean }) =>
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
        if (result !== null) status.reload();
        return;
      }
      const result = await enable.run({
        profile,
        rolloutPercent,
        extraBudgetMicrousd,
        budgetAcknowledged: acknowledged
      });
      if (result !== null) {
        // The acknowledgement belongs to the disclosure just accepted: a later re-enable (which
        // clears the breaker) must be a deliberate act, not a leftover checkbox.
        setAcknowledged(false);
        status.reload();
      }
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
      <div className="flex flex-wrap items-center gap-2 text-[var(--font-meta-size)]" data-testid="settings-pilot-state">
        <span className="text-subtle text-[var(--font-micro-size)]">当前状态</span>
        <span className="text-ink">{settings.enabled ? `已开启 · ${settings.profile}` : '已关闭'}</span>
        {settings.circuitOpen ? (
          <span className="text-[var(--st-warn)]">
            · 熔断中{settings.breakerReason === null ? '' : ` · ${settings.breakerReason}`}
          </span>
        ) : null}
        <span className="text-subtle">
          · 失败连击 {settings.failureStreak}/{settings.maxFailureStreak}
          {settings.budgetAcknowledgedAt === null ? '' : ` · 预算确认于 ${settings.budgetAcknowledgedAt}`}
        </span>
      </div>


      <label className="flex max-w-[520px] flex-col gap-0.5">
        <span className="text-subtle text-[var(--font-micro-size)]">配置文件</span>
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
        <div className="w-[180px]">
          <NumberField
            label="额外预算上限（microusd）"
            value={extraBudgetMicrousd}
            onChange={(next) => setExtraBudgetMicrousd(next === null || next === undefined ? 1 : next)}
            min={1}
            disabled={busy}
            testId="settings-pilot-budget"
          />
        </div>
      </div>

      <label className="flex items-start gap-2 text-[var(--font-meta-size)] text-muted">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          disabled={busy}
          data-testid="settings-pilot-acknowledge"
          className="mt-0.5"
        />
        <span>我了解试点会为该运行申请额外预算，并可能因额度耗尽或连续失败自动熔断。</span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="settings-pilot-enable"
          disabled={busy || !acknowledged || extraBudgetMicrousd < 1}
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
          className="flex flex-col gap-0.5 text-[var(--font-meta-size)] text-muted"
          data-testid="settings-pilot-last-run"
        >
          <span className="text-subtle text-[var(--font-micro-size)]">最近一次试点运行</span>
          <span>
            <span className="font-mono">{data.lastRun.runId}</span> · {data.lastRun.profile ?? '无配置'} · 分桶{' '}
            {data.lastRun.bucket} · {data.lastRun.state}
          </span>
          <span className="text-subtle">当次披露：{data.lastRun.disclosure}</span>
          <span>
            已用 {data.lastRun.spent.modelCalls}/{data.lastRun.allowance.modelCalls} 次模型调用 ·{' '}
            {data.lastRun.spent.toolCalls}/{data.lastRun.allowance.toolCalls} 次工具调用 ·{' '}
            {data.lastRun.spent.totalTokens}/{data.lastRun.allowance.totalTokens} tokens
          </span>
        </div>
      )}

    </FormSection>
  );
}
