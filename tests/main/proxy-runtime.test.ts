import { afterEach, describe, expect, it, vi } from 'vitest';

const setGlobalProxyFromEnv = vi.fn();

vi.mock('node:http', () => ({
  setGlobalProxyFromEnv
}));

describe('proxy runtime bootstrap', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.NODE_USE_ENV_PROXY;
  });

  it('enables Node env proxy support before network tools run', async () => {
    expect(process.env.NODE_USE_ENV_PROXY).toBeUndefined();

    await import('../../src/main/proxy-runtime');

    expect(process.env.NODE_USE_ENV_PROXY).toBe('1');
    expect(setGlobalProxyFromEnv).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing NODE_USE_ENV_PROXY value while still syncing the global proxy dispatcher', async () => {
    process.env.NODE_USE_ENV_PROXY = 'custom';

    await import('../../src/main/proxy-runtime');

    expect(process.env.NODE_USE_ENV_PROXY).toBe('custom');
    expect(setGlobalProxyFromEnv).toHaveBeenCalledTimes(1);
  });
});
