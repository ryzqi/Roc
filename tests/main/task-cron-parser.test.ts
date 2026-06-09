import { describe, expect, it } from 'vitest';
import { computeNextCronRunAt, parseCronExpression } from '../../src/main/plugins/task/cron-parser';
import { RocDomainError } from '../../src/main/services/errors';

function localIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

describe('task cron parser', () => {
  it('computes the next daily 09:00 run', () => {
    const next = computeNextCronRunAt('0 9 * * *', new Date(2026, 0, 5, 8, 58, 0, 0));

    expect(next).toBe(localIso(2026, 1, 5, 9, 0));
  });

  it('computes the next 15-minute interval', () => {
    const next = computeNextCronRunAt('*/15 * * * *', new Date(2026, 0, 5, 8, 44, 0, 0));

    expect(next).toBe(localIso(2026, 1, 5, 8, 45));
  });

  it('computes weekday 09:00 runs from day-of-week ranges', () => {
    const friday = new Date(2026, 0, 9, 9, 1, 0, 0);
    const next = computeNextCronRunAt('0 9 * * 1-5', friday);

    expect(next).toBe(localIso(2026, 1, 12, 9, 0));
  });

  it('computes weekly Sunday 22:00 runs', () => {
    const next = computeNextCronRunAt('0 22 * * 0', new Date(2026, 0, 5, 8, 0, 0, 0));

    expect(next).toBe(localIso(2026, 1, 11, 22, 0));
  });

  it('rejects invalid cron expressions with a scheduler error code', () => {
    expect(() => parseCronExpression('0 9 * * * *')).toThrow(RocDomainError);
    expect(() => parseCronExpression('-1 9 * * *')).toThrow('Cron 表达式无效。');
    expect(() => parseCronExpression('0 24 * * *')).toThrow('Cron 表达式无效。');
    try {
      parseCronExpression('0 9 * * * *');
      throw new Error('Expected invalid cron to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(RocDomainError);
      expect((error as RocDomainError).code).toBe('background_task_cron_invalid');
    }
  });

  it('always returns a future instant across calendar edge cases', () => {
    const after = new Date(2026, 2, 29, 1, 59, 0, 0);
    const next = new Date(computeNextCronRunAt('0 2 * * *', after));

    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });
});
