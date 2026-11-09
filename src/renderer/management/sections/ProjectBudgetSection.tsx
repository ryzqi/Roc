import { useEffect, useState } from 'react';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import { FormSection, TextField, formButtonClass, formPrimaryButtonClass, formSecondaryButtonClass } from '../../shared/form-ui';
import type { RocClient } from '../../shared/roc-client';

type BudgetDraft = { revision: number; tokens: string; models: string; concurrentModels: string; cost: string };
const number = new Intl.NumberFormat('zh-CN');
const usd = (amount: number): string => `$${(amount / 1_000_000).toFixed(6)}`;
const positiveInteger = (value: string): boolean => /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
const nonnegativeInteger = (value: string): boolean => /^(0|[1-9]\d*)$/u.test(value) && Number.isSafeInteger(Number(value));

export function ProjectBudgetSection({ client, projectId }: {
  client: RocClient; projectId: string;
}): React.JSX.Element {
  const resource = useAsyncResource(`project-budget:${projectId}`, async () => {
    const result = await client.api.research.getProjectBudget({ projectId });
    if (result.ok && result.data !== null && result.data.projectId !== projectId) throw new Error('research_project_budget_identity_mismatch');
    return result;
  }, { label: '读取项目模型预算' });
  const [draft, setDraft] = useState<BudgetDraft | null>(null);
  const save = useAsyncAction(async (input: BudgetDraft) => client.api.research.saveProjectBudget({
    projectId, expectedRevision: input.revision,
    limits: { maxTotalTokens: Number(input.tokens), maxModelCalls: Number(input.models),
      maxConcurrentModelCalls: Number(input.concurrentModels), maxCostMicrousd: input.cost === '' ? null : Number(input.cost) }
  }), { label: '保存项目模型预算' });
  const reload = resource.reload;
  useEffect(() => {
    const budget = client.api.research.onProjectBudgetUpdated(event => { if (event.projectId === projectId) reload(); });
    const task = client.api.research.onTaskUpdated(event => { if (event.projectId === projectId) reload(); });
    const chat = client.api.chat.onRunEvent(event => { if (event.type === 'run_budget') reload(); });
    return () => { budget(); task(); chat(); };
  }, [client, projectId, reload]);
  const data = resource.data;
  const invalid = draft !== null && (!positiveInteger(draft.tokens) || !positiveInteger(draft.models) ||
    !positiveInteger(draft.concurrentModels) || (draft.cost !== '' && !nonnegativeInteger(draft.cost)));
  const update = (field: keyof Omit<BudgetDraft, 'revision'>, value: string): void => {
    setDraft(current => current === null ? null : { ...current, [field]: value });
  };
  return (
    <FormSection title="项目模型预算" testId="mgmt-project-budget">
      {resource.status === 'error' ? (
        <div>
          <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p>
          <button type="button" className={formSecondaryButtonClass} onClick={reload}>重试项目预算</button>
        </div>
      ) : resource.status === 'loading' && data === null ? <p role="status" className="text-subtle">读取项目预算中…</p> :
        data === null ? <p className="text-[var(--st-warn)]">尚未配置项目预算，模型调用已禁用。</p> : (
          <div className="grid gap-3 text-muted text-[length:var(--font-meta-size)]" data-testid="mgmt-project-budget-data">
            <dl className="form-grid">
              <div className="min-w-0 space-y-1">
                <dt>剩余 Tokens</dt>
                <dd className="font-medium tabular-nums text-ink">{number.format(data.tokens.remaining)}</dd>
                <dd>已结算 <span className="tabular-nums">{number.format(data.tokens.settled)}</span></dd>
                <dd>预留 <span className="tabular-nums">{number.format(data.tokens.reserved)}</span>，未知 <span className="tabular-nums">{number.format(data.tokens.unknown)}</span></dd>
              </div>
              <div className="min-w-0 space-y-1">
                <dt>模型调用</dt>
                <dd className="font-medium tabular-nums text-ink">{number.format(data.models.total)} / {number.format(data.limits.maxModelCalls)}</dd>
                <dd>并发 <span className="tabular-nums">{data.models.reserved} / {data.limits.maxConcurrentModelCalls}</span></dd>
              </div>
              <div className="min-w-0 space-y-1">
                <dt>已结算费用</dt>
                <dd className="font-medium tabular-nums text-ink">{usd(data.cost.settledMicrousd)}</dd>
                <dd>预留 <span className="tabular-nums">{usd(data.cost.reservedMicrousd)}</span></dd>
                <dd>上限 <span className="tabular-nums">{data.limits.maxCostMicrousd === null ? '未设置' : usd(data.limits.maxCostMicrousd)}</span></dd>
                {data.cost.state === 'unknown' ? <dd className="text-[var(--st-warn)]">部分费用未知</dd> : null}
              </div>
            </dl>
            {data.stopReason === null ? null : <p className="break-words text-[var(--st-warn)]">停止原因：{data.stopReason}</p>}
          </div>
        )}
      {draft === null ? (
        <button type="button" className={`${formSecondaryButtonClass} self-start`}
          data-testid="mgmt-project-budget-edit" disabled={resource.status !== 'ready'} onClick={() => {
            save.reset();
            setDraft({ revision: data?.revision ?? 0, tokens: data === null ? '' : String(data.limits.maxTotalTokens),
              models: data === null ? '' : String(data.limits.maxModelCalls),
              concurrentModels: data === null ? '' : String(data.limits.maxConcurrentModelCalls),
              cost: data?.limits.maxCostMicrousd === null || data === null ? '' : String(data.limits.maxCostMicrousd) });
          }}>{data === null ? '配置项目预算' : '修改项目预算'}</button>
      ) : (
        <form className="grid min-w-0 gap-3" onSubmit={event => {
          event.preventDefault();
          if (invalid || save.pending) return;
          void save.run(draft).then(result => { if (result.ok) { setDraft(null); reload(); } });
        }}>
          <div className="form-grid">
            <TextField label="项目 Token 总额" inputMode="numeric" value={draft.tokens} onChange={value => update('tokens', value)}
              issue={positiveInteger(draft.tokens) ? null : '请输入有效的正整数'}
              disabled={save.pending} testId="mgmt-project-budget-tokens" />
            <TextField label="模型调用上限" inputMode="numeric" value={draft.models} onChange={value => update('models', value)}
              issue={positiveInteger(draft.models) ? null : '请输入有效的正整数'}
              disabled={save.pending} testId="mgmt-project-budget-models" />
            <TextField label="模型并发上限" inputMode="numeric" value={draft.concurrentModels} onChange={value => update('concurrentModels', value)}
              issue={positiveInteger(draft.concurrentModels) ? null : '请输入有效的正整数'}
              disabled={save.pending} testId="mgmt-project-budget-concurrency" />
            <TextField label="费用上限" inputMode="numeric" description="单位：微美元；留空表示未设置。" value={draft.cost} onChange={value => update('cost', value)}
              issue={draft.cost === '' || nonnegativeInteger(draft.cost) ? null : '请输入有效的非负整数，或留空'}
              disabled={save.pending} testId="mgmt-project-budget-cost" />
          </div>
          <p className="text-subtle text-[length:var(--font-meta-size)]">预算累计包含整个项目的历史调用。修改上限不会重置消耗。</p>
          {save.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{save.error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={formPrimaryButtonClass} disabled={invalid || save.pending}
              data-testid="mgmt-project-budget-save">{save.pending ? '保存中…' : '保存预算'}</button>
            <button type="button" className={formButtonClass} disabled={save.pending} onClick={() => setDraft(null)}>取消</button>
          </div>
        </form>
      )}
    </FormSection>
  );
}
