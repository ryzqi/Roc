import { describe, expect, it } from 'vitest';
import { formatBeijingDateTime } from '../../src/renderer/format-time';

describe('formatBeijingDateTime', () => {
  it('converts UTC ISO to Beijing time in YYYY-MM-DD HH:mm form', () => {
    expect(formatBeijingDateTime('2026-05-08T15:30:45.000Z')).toBe('2026-05-08 23:30');
  });

  it('rolls the day forward when UTC time crosses 16:00', () => {
    expect(formatBeijingDateTime('2026-05-11T16:00:00.000Z')).toBe('2026-05-12 00:00');
  });

  it('keeps the same day for early UTC morning', () => {
    expect(formatBeijingDateTime('2026-05-11T00:00:00.000Z')).toBe('2026-05-11 08:00');
  });

  it('rolls the month forward at the day boundary', () => {
    expect(formatBeijingDateTime('2026-05-31T16:00:00.000Z')).toBe('2026-06-01 00:00');
  });

  it('zero-pads single-digit month, day, hour, and minute', () => {
    expect(formatBeijingDateTime('2026-01-05T01:05:00.000Z')).toBe('2026-01-05 09:05');
  });

  it('truncates seconds and milliseconds', () => {
    expect(formatBeijingDateTime('2026-05-09T07:30:59.999Z')).toBe('2026-05-09 15:30');
  });
});
