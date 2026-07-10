import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';

import { CapabilityRegistry } from '../../src/main/kernel/capability-registry';
import { createTaskPlugin } from '../../src/main/plugins/task';
import { MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE } from '../../src/shared/background-task-tool-contract';
import type { BackgroundTaskPreviewRequest } from '../../src/shared/types';
import { invalidProposeInput, minimalProposeToolInput, validProposeInput } from '../_factories/background-task';

describe('background task propose schema', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each([
    [
      'manual minimal',
      validProposeInput({
        trigger: {
          type: 'manual',
          description: '手动'
        }
      })
    ],
    [
      'once with ISO',
      validProposeInput({
        trigger: {
          type: 'once',
          description: '一次',
          nextRunAt: '2026-05-25T13:00:00.000Z'
        }
      })
    ],
    [
      'cron five fields',
      validProposeInput({
        trigger: {
          type: 'cron',
          description: '每天 21:50',
          cronExpression: '50 21 * * *',
          nextRunAt: '2026-05-25T13:50:00.000Z'
        }
      })
    ]
  ])('accepts %s', (_name, input) => {
    it('parses without throwing', () => {
      expect(input).toBeAcceptedByProposeSchema();
    });
  });

  it('model-visible schema accepts cron input without workspacePath or trigger.description', () => {
    expect(
      minimalProposeToolInput({
        trigger: {
          type: 'cron',
          cronExpression: '0 13 * * *',
          nextRunAt: '2026-06-17T05:00:00.000Z'
        }
      })
    ).toBeAcceptedByProposeToolSchema();
  });

  it('model-visible schema accepts but ignores legacy workspacePath from the model', () => {
    expect(
      minimalProposeToolInput({
        workspacePath: '/workspace/',
        trigger: {
          type: 'cron',
          cronExpression: '0 13 * * *',
          nextRunAt: '2026-06-17T05:00:00.000Z'
        }
      })
    ).toBeAcceptedByProposeToolSchema();
  });

  describe.each([
    ['trigger.schedule', invalidProposeInput('trigger.schedule'), 'trigger'],
    ['trigger.expr', invalidProposeInput('trigger.expr'), 'trigger'],
    ['trigger.expression', invalidProposeInput('trigger.expression'), 'trigger'],
    ['trigger.cron alias', invalidProposeInput('trigger.cron-alias'), 'trigger'],
    ['notification on_error', invalidProposeInput('notification-on-error'), 'notificationPolicy'],
    ['missing trigger.type', invalidProposeInput('missing-trigger-type'), 'trigger.type'],
    ['non-ISO nextRunAt', invalidProposeInput('non-iso-nextRunAt'), 'trigger.nextRunAt'],
    ['extra unknown key', invalidProposeInput('extra-unknown-key'), 'trigger']
  ])('rejects %s', (_name, input, path) => {
    it(`fails at ${path}`, () => {
      expect(input).toBeRejectedByProposeSchemaAtPath(path);
    });
  });

  it.each([
    ['notificationPolicy default', { notificationPolicy: 'default' }],
    ['notificationPolicy on_error', { notificationPolicy: 'on_error' }],
    ['allowedActions', { allowedActions: [] }],
    ['forbiddenActions', { forbiddenActions: [] }],
    ['enabledCapabilities', { enabledCapabilities: { mcpServers: [], skills: [] } }]
  ])('model-visible schema rejects %s', (_name, extra) => {
    const key = Object.keys(extra)[0] as string;
    expect({
      ...MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE,
      ...extra
    }).toBeRejectedByProposeToolSchemaAtPath(key);
  });

  it('rejects arbitrary unknown trigger keys on cron payloads', () => {
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/u)
          .filter((key) => !['type', 'description', 'cronExpression', 'nextRunAt'].includes(key)),
        fc.string(),
        (key, value) => {
          const bad = validProposeInput();
          (bad.trigger as Record<string, unknown>)[key] = value;
          expect(bad).toBeRejectedByProposeSchemaAtPath('trigger');
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('background task capability schemas', () => {
  it('rejects renderer-derived fields on create before handler execution', async () => {
    await expectTaskCapabilityInputRejected('task.background.create', {
      ...backgroundTaskPreviewRequest(),
      riskLevel: 'low',
      requiresConfirmation: false
    });
  });

  it('rejects an incomplete cron trigger on preview before handler execution', async () => {
    await expectTaskCapabilityInputRejected('task.background.preview', {
      ...backgroundTaskPreviewRequest(),
      trigger: {
        type: 'cron',
        description: 'nightly',
        cronExpression: '0 0 * * *'
      }
    });
  });

  it('rejects derived fields inside an update patch before handler execution', async () => {
    await expectTaskCapabilityInputRejected('task.background.update', {
      taskId: 'task-1',
      patch: {
        riskLevel: 'low'
      },
      reason: 'forged renderer update'
    });
  });
});

async function expectTaskCapabilityInputRejected(name: string, input: unknown): Promise<void> {
  const plugin = createTaskPlugin();
  const descriptor = plugin.manifest.capabilities.find((capability) => capability.name === name);
  if (descriptor === undefined) {
    throw new Error(`Missing task capability descriptor: ${name}`);
  }
  const capabilities = new CapabilityRegistry();
  const handler = vi.fn(async () => ({}));
  capabilities.declare(plugin.manifest.id, descriptor);
  capabilities.register(plugin.manifest.id, descriptor, handler);

  await expect(capabilities.invoke(name, input)).rejects.toThrow(z.ZodError);
  expect(handler).not.toHaveBeenCalled();
}

function backgroundTaskPreviewRequest(): BackgroundTaskPreviewRequest {
  return {
    goal: 'Review plugin state',
    trigger: {
      type: 'manual',
      description: 'Manual'
    },
    workspacePath: 'F:\\Code\\Roc',
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations'
  };
}
