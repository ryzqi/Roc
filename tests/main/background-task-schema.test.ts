import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
