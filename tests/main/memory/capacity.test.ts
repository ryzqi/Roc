import { describe, expect, it } from 'vitest';
import { CapacityService } from '../../../src/main/services/memory/capacity';

const limits = { user: 1375, agents: 800, memory: 2200 };

describe('CapacityService', () => {
  it('uses code-point count, emoji and CJK each count as 1', () => {
    const svc = new CapacityService(limits);
    expect(svc.check('user', '🎉🎉🎉').chars).toBe(3);
    expect(svc.check('user', '中文测试').chars).toBe(4);
    expect(svc.check('user', 'abc🎉中').chars).toBe(5);
  });

  it('passes at exactly the limit', () => {
    const svc = new CapacityService({ user: 5, agents: 5, memory: 5 });
    const result = svc.check('user', 'abcde');
    expect(result).toEqual({ ok: true, chars: 5, limit: 5 });
  });

  it('fails one above the limit', () => {
    const svc = new CapacityService({ user: 5, agents: 5, memory: 5 });
    const result = svc.check('user', 'abcdef');
    expect(result).toEqual({ ok: false, chars: 6, limit: 5 });
  });

  it('passes empty content', () => {
    const svc = new CapacityService(limits);
    const result = svc.check('memory', '');
    expect(result).toEqual({ ok: true, chars: 0, limit: 2200 });
  });

  it('routes by kind to correct limit', () => {
    const svc = new CapacityService(limits);
    expect(svc.check('user', '').limit).toBe(1375);
    expect(svc.check('agents', '').limit).toBe(800);
    expect(svc.check('memory', '').limit).toBe(2200);
  });

  it('formats overflow with char count and consolidation guidance', () => {
    const svc = new CapacityService(limits);
    const detail = svc.formatOverflow('memory', 2201, 2200);
    expect(detail).toContain('Write blocked: capacity exceeded');
    expect(detail).toContain('chars: 2201/2200');
    expect(detail).toContain('consolidate');
  });
});
