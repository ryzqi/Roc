import { describe, expect, it } from 'vitest';
import type { RocPreloadApi } from '../../../src/shared/ipc';
import { createRocClient } from '../../../src/renderer/shared/roc-client';

describe('createRocClient', () => {
  it('returns the provided preload api', () => {
    const api = { app: { getStatus: async () => ({ ok: true, data: null }) } } as unknown as RocPreloadApi;

    const client = createRocClient(api);

    expect(client.api).toBe(api);
  });
});
