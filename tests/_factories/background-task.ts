import type { BackgroundTaskPreviewRequest } from '../../src/shared/types';

type ProposeInput = Omit<BackgroundTaskPreviewRequest, 'failurePolicy'> & {
  enabledCapabilities?: BackgroundTaskPreviewRequest['enabledCapabilities'];
};

type DeepPartial<T> = T extends Array<infer Item>
  ? Array<DeepPartial<Item>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type InvalidProposeInputKind =
  | 'trigger.schedule'
  | 'trigger.expr'
  | 'trigger.expression'
  | 'trigger.cron-alias'
  | 'cron-six-fields'
  | 'notification-on-error'
  | 'missing-trigger-type'
  | 'non-iso-nextRunAt'
  | 'extra-unknown-key';

export function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function validProposeInput(overrides: DeepPartial<ProposeInput> = {}): ProposeInput {
  return mergeProposeInput(
    {
      goal: '每天 21:50 抓取 AI 最新新闻并写入当前工作区的 docx 文件',
      trigger: {
        type: 'cron',
        description: '每天 21:50 触发',
        cronExpression: '50 21 * * *',
        nextRunAt: futureIso()
      },
      workspacePath: 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      notificationPolicy: 'failures_and_confirmations'
    },
    overrides
  );
}

export function invalidProposeInput(kind: InvalidProposeInputKind): unknown {
  switch (kind) {
    case 'trigger.schedule':
      return validProposeInput({
        trigger: {
          schedule: '50 21 * * *'
        } as unknown as DeepPartial<ProposeInput['trigger']>
      });
    case 'trigger.expr':
      return validProposeInput({
        trigger: {
          type: 'cron',
          description: '每天 21:50 触发',
          expr: '50 21 * * *',
          nextRunAt: futureIso()
        } as unknown as DeepPartial<ProposeInput['trigger']>
      });
    case 'trigger.expression':
      return validProposeInput({
        trigger: {
          type: 'cron',
          description: '每天 21:50 触发',
          expression: '50 21 * * *',
          nextRunAt: futureIso()
        } as unknown as DeepPartial<ProposeInput['trigger']>
      });
    case 'trigger.cron-alias':
      return validProposeInput({
        trigger: {
          type: 'cron',
          description: '每天 21:50 触发',
          cron: '50 21 * * *',
          nextRunAt: futureIso()
        } as unknown as DeepPartial<ProposeInput['trigger']>
      });
    case 'cron-six-fields':
      return validProposeInput({
        trigger: {
          type: 'cron',
          description: '每天 21:50 触发',
          cronExpression: '0 50 21 * * *',
          nextRunAt: futureIso()
        }
      });
    case 'notification-on-error':
      return validProposeInput({
        notificationPolicy: 'on_error' as ProposeInput['notificationPolicy']
      });
    case 'missing-trigger-type':
      return validProposeInput({
        trigger: {
          description: '每天 21:50 触发',
          cronExpression: '50 21 * * *',
          nextRunAt: futureIso()
        } as unknown as DeepPartial<ProposeInput['trigger']>
      });
    case 'non-iso-nextRunAt':
      return validProposeInput({
        trigger: {
          type: 'cron',
          description: '每天 21:50 触发',
          cronExpression: '50 21 * * *',
          nextRunAt: '2026/05/25 21:50'
        }
      });
    case 'extra-unknown-key':
      return validProposeInput({
        trigger: {
          type: 'cron',
          description: '每天 21:50 触发',
          cronExpression: '50 21 * * *',
          nextRunAt: futureIso(),
          unexpected: 'x'
        } as unknown as DeepPartial<ProposeInput['trigger']>
      });
  }
}

function mergeProposeInput(base: ProposeInput, overrides: DeepPartial<ProposeInput>): ProposeInput {
  const trigger = overrides.trigger === undefined ? base.trigger : (overrides.trigger as ProposeInput['trigger']);
  return {
    ...base,
    ...overrides,
    trigger,
    allowedActions: overrides.allowedActions === undefined ? base.allowedActions : (overrides.allowedActions as string[]),
    forbiddenActions: overrides.forbiddenActions === undefined ? base.forbiddenActions : (overrides.forbiddenActions as string[])
  } as ProposeInput;
}
