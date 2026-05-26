import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE } from '../../src/shared/background-task-tool-contract';
import { invalidProposeInput, validProposeInput } from '../_factories/background-task';

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
