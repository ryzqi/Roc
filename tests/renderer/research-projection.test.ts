import { describe, expect, it } from 'vitest';

import { createProjectionController } from '../../src/renderer/views/research/research-projection';

describe('research projection controller', () => {
  it('keeps working true when a second command is rejected', async () => {
    const projection = createProjectionController({
      empty: () => ({ working: false, error: null as string | null }),
      copy: (value) => ({ ...value })
    });
    let release: (() => void) | undefined;
    const pending = projection.runExclusive(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    }, { busy: '当前命令仍在进行。', failed: 'failed' });
    await Promise.resolve();
    expect(projection.getSnapshot().working).toBe(true);
    await projection.runExclusive(async () => undefined, { busy: '当前命令仍在进行。', failed: 'failed' });
    expect(projection.getSnapshot().error).toBe('当前命令仍在进行。');
    expect(projection.getSnapshot().working).toBe(true);
    release?.();
    await pending;
    expect(projection.getSnapshot().working).toBe(false);
  });
});
